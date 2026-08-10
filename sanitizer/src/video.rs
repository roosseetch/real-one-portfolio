//! One sanitised MP4 and the poster derivatives that stand in for it.
//!
//! The decoy is written by the same ffmpeg invocation that does the transcode.
//! That is not a convenience: the previous implementation transcoded, then had
//! a tag editor rewrite the file to add the decoy, which moved `moov` back
//! behind `mdat` often enough that it needed a third pass to put it back. One
//! pass writes the file once, and `+faststart` is applied by the muxer with the
//! metadata already in place, so it cannot be undone afterwards.

use anyhow::{bail, Context, Result};
use rand::SeedableRng;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::Command;

use crate::decoy::{iso6709, Decoy};
use crate::image::{self, Naming};
use crate::manifest::{Entry, Role};
use crate::{Options, Outcome};

/// What a sanitised container is still allowed to say about itself. Everything
/// else ffprobe can read is either the camera's or the encoder's, and both are
/// facts about the author that the published file has no reason to carry.
const ALLOWED_CONTAINER_TAGS: &[&str] = &[
    "major_brand",
    "minor_version",
    "compatible_brands",
    "language",
    // Written by us, deliberately, and checked against what we wrote.
    "make",
    "model",
    "com.apple.quicktime.make",
    "com.apple.quicktime.model",
    "location",
    "com.apple.quicktime.location.iso6709",
];

/// Three tags the MP4 muxer writes whatever it is told, so they cannot be
/// removed -- only made to say nothing. They are checked by value rather than
/// waved through by name, because the *value* is the whole difference: a
/// bitexact transcode writes "VideoHandler", a zeroed vendor and a versionless
/// encoder, where an iPhone's original says "Core Media Video" and a
/// non-bitexact one says "Lavc60.31.102 libx264". Allowing the keys outright
/// would let an untranscoded passthrough travel as though it had been
/// sanitised.
fn muxer_constant_is_generic(name: &str, value: &str) -> Option<bool> {
    let value = value.trim().to_lowercase();
    match name {
        "handler_name" => Some(matches!(
            value.as_str(),
            "" | "videohandler" | "soundhandler" | "subtitlehandler"
        )),
        "vendor_id" => Some(matches!(value.as_str(), "" | "[0][0][0][0]")),
        "encoder" => {
            // "Lavc libx264" is what bitexact leaves; "Lavc60.31.102 libx264"
            // is what it looks like when the flag did not take.
            let first = value.split_whitespace().next().unwrap_or("");
            Some(value.starts_with("lavc ") && !first.chars().any(|c| c.is_ascii_digit()))
        }
        _ => None,
    }
}

/// What the file is, as ffprobe reports it rather than as anything claims.
///
/// `width` and `height` are *display* dimensions. A phone shooting in portrait
/// stores 1920x1080 pixels plus a rotation matrix, and ffmpeg's autorotate
/// bakes that matrix into the output pixels -- so comparing coded dimensions
/// across the transcode reports a failure on every portrait video ever sent.
#[derive(Debug, Clone, Default)]
pub struct VideoProperties {
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub video_codec: String,
    pub has_audio: bool,
    pub audio_codec: Option<String>,
    pub audio_channels: Option<u32>,
    pub rotation: i64,
    /// Carries the bit depth: "yuv420p" is eight, "yuv420p10le" is ten.
    pub pix_fmt: String,
    /// The transfer function. "arib-std-b67" is HLG and "smpte2084" is PQ, which
    /// are the two ways a phone records HDR.
    pub color_transfer: Option<String>,
    pub format_tags: BTreeMap<String, String>,
    pub stream_tags: Vec<BTreeMap<String, String>>,
}

/// Degrees of display rotation, from either place ffprobe reports it.
///
/// Newer builds put it in side_data_list as a float; older ones leave it in the
/// stream tags. Neither is metadata `-map_metadata` can reach.
fn rotation_of(stream: &Value) -> i64 {
    if let Some(sides) = stream.get("side_data_list").and_then(Value::as_array) {
        for side in sides {
            if let Some(rotation) = side.get("rotation").and_then(Value::as_f64) {
                return (rotation.round() as i64).rem_euclid(360);
            }
        }
    }
    stream
        .get("tags")
        .and_then(|tags| tags.get("rotate"))
        .and_then(|value| match value {
            Value::String(text) => text.parse::<f64>().ok(),
            other => other.as_f64(),
        })
        .map(|rotation| (rotation.round() as i64).rem_euclid(360))
        .unwrap_or(0)
}

fn tags_of(node: &Value) -> BTreeMap<String, String> {
    node.get("tags")
        .and_then(Value::as_object)
        .map(|tags| {
            tags.iter()
                .map(|(key, value)| {
                    let text = match value {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    (key.clone(), text)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Reads the properties every later decision depends on.
///
/// Fails on a file ffprobe cannot open, which is exactly the invalid-file case:
/// something arrived named like a video and is not one.
pub fn probe(path: &Path) -> Result<VideoProperties> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .context("ffprobe could not be run")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = stderr
            .trim()
            .lines()
            .last()
            .unwrap_or("unreadable")
            .to_string();
        bail!("ffprobe could not read it: {detail}");
    }

    let probed: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    let empty = Vec::new();
    let streams = probed
        .get("streams")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video"))
        .context("no video stream")?;

    // ffprobe reads a still picture as a one-frame video, so a JPEG that
    // arrives named .mp4 would otherwise transcode into a 0.04-second clip
    // whose poster frame is the picture itself. The Worker's own sniffing
    // refuses to file one as a video, but that is a check in another process;
    // this is the one that holds if the file ever gets here another way.
    let codec = video
        .get("codec_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(codec, "mjpeg" | "png" | "bmp" | "gif" | "webp" | "tiff") {
        bail!("a still {codec} picture, not a video");
    }

    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"));

    let rotation = rotation_of(video);
    let mut width = video.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
    let mut height = video.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    if rotation == 90 || rotation == 270 {
        std::mem::swap(&mut width, &mut height);
    }
    if width == 0 || height == 0 {
        bail!("no usable dimensions");
    }

    let parse_duration = |node: &Value| -> Option<f64> {
        node.get("duration").and_then(|d| match d {
            Value::String(text) => text.parse().ok(),
            other => other.as_f64(),
        })
    };
    let duration = probed
        .get("format")
        .and_then(parse_duration)
        .or_else(|| parse_duration(video))
        .unwrap_or(0.0);

    Ok(VideoProperties {
        width,
        height,
        duration,
        video_codec: codec.to_string(),
        has_audio: audio.is_some(),
        audio_codec: audio
            .and_then(|a| a.get("codec_name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        audio_channels: audio
            .and_then(|a| a.get("channels"))
            .and_then(Value::as_u64)
            .map(|c| c as u32),
        rotation,
        pix_fmt: video
            .get("pix_fmt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // "unknown" is what ffprobe says for a file that never declared one, and
        // that is not the same claim as HDR.
        color_transfer: video
            .get("color_transfer")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && *value != "unknown")
            .map(str::to_string),
        format_tags: probed.get("format").map(tags_of).unwrap_or_default(),
        stream_tags: streams.iter().map(tags_of).collect(),
    })
}

/// The output's display size: the input's, unless it is over the cap.
///
/// Both dimensions are forced even, because yuv420p subsamples chroma by two
/// and an odd dimension is not representable.
pub fn scaled_size(props: &VideoProperties, max_width: u32) -> (u32, u32) {
    let longest = props.width.max(props.height);
    if longest <= max_width {
        return (props.width, props.height);
    }

    let factor = f64::from(max_width) / f64::from(longest);
    let even = |value: f64| ((value.round() as u32) & !1).max(2);
    (
        even(f64::from(props.width) * factor),
        even(f64::from(props.height) * factor),
    )
}

/// The ffmpeg command line, as a value, so it can be asserted on directly.
///
/// Every flag here is either the transcode the spec asks for, a specific thing
/// a camera writes that would otherwise survive it, or the decoy.
pub fn transcode_args(
    source: &Path,
    out_path: &Path,
    props: &VideoProperties,
    decoy: &Decoy,
    location: &str,
    options: &Options,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push("-i".into());
    args.push(source.to_string_lossy().into_owned());

    // Explicit stream selection, not the default. An iPhone MOV carries a
    // `tmcd` track holding the camera's clock and often an `mebx` track of
    // per-frame gyro and location samples. Defaults happen to drop them; a map
    // guarantees it.
    args.extend(["-map".into(), "0:v:0".into()]);
    if props.has_audio {
        args.extend(["-map".into(), "0:a:0".into()]);
    }

    // The global dictionary: com.apple.quicktime.location.ISO6709, .make,
    // .model, .software, creation_time, Android's com.android.version.
    args.extend(["-map_metadata".into(), "-1".into()]);
    // Per-stream metadata is copied from the matching input stream and
    // `-map_metadata -1` does not touch it. handler_name ("Core Media Video"),
    // vendor_id and per-stream creation_time all live here.
    args.extend(["-map_metadata:s:v".into(), "-1".into()]);
    if props.has_audio {
        args.extend(["-map_metadata:s:a".into(), "-1".into()]);
    }
    args.extend(["-map_chapters".into(), "-1".into()]);

    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        options.video_preset.clone(),
        "-crf".into(),
        options.video_crf.to_string(),
        // High profile at 8-bit 4:2:0 is what Safari on iOS will actually
        // decode. A 10-bit or 4:2:2 source would otherwise publish a file that
        // plays here and refuses to play there.
        "-profile:v".into(),
        "high".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        // Without this libx264 writes its own settings string into the first
        // frame as SEI user data -- "x264 - core 164 ... cabac=1 ref=3 ...",
        // which is encoder identification by any reading.
        "-flags:v".into(),
        "+bitexact".into(),
    ]);

    let (width, height) = scaled_size(props, options.video_max_width);
    if (width, height) != (props.width, props.height) {
        args.extend([
            "-vf".into(),
            format!("scale={width}:{height}:flags=lanczos"),
        ]);
    }

    if props.has_audio {
        // No -ac and no -ar: forcing stereo upmixes a mono voice memo and
        // doubles its bitrate for nothing. Channels pass through and are
        // compared afterwards.
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
            "-flags:a".into(),
            "+bitexact".into(),
        ]);
    } else {
        args.push("-an".into());
    }

    // The decoy, written by the muxer rather than by a tag editor afterwards.
    //
    // Deliberately no date. An MP4 stores its dates as 32-bit seconds since
    // 1904, which runs out in 2040 -- so the configured 2117 does not fail to
    // write, it *wraps*, and the file comes out claiming 1981. A decoy is meant
    // to be an obvious fiction; a plausible wrong date is the opposite of one.
    // The bitexact flags below zero every container date, so writing nothing
    // leaves nothing, which is the honest outcome here. The poster still
    // carries the 2117 stamp: EXIF has no such ceiling.
    // The Apple Keys namespace rather than the bare `make`/`model`/`location`
    // udta form. Both survive the muxer and both pass the workflow's allowlist,
    // but a decoy exists to make the file look ordinary, and what an ordinary
    // phone clip carries is these keys. It is also what the previous
    // implementation wrote, so a video published today and one published last
    // month answer the same question the same way.
    args.extend([
        "-metadata".into(),
        format!("com.apple.quicktime.make={}", decoy.camera.make),
    ]);
    args.extend([
        "-metadata".into(),
        format!("com.apple.quicktime.model={}", decoy.camera.model),
    ]);
    args.extend([
        "-metadata".into(),
        format!("com.apple.quicktime.location.ISO6709={location}"),
    ]);

    args.extend([
        // As an output option this reaches the muxer: no "Lavf<version>"
        // writing application, and zeroed mvhd/tkhd/mdhd times rather than
        // "now". A fresh transcode otherwise stamps today's date into the
        // container.
        "-fflags".into(),
        "+bitexact".into(),
        // faststart puts moov ahead of mdat: the site serves this file straight
        // off R2, so without it a browser must fetch the whole body before the
        // first frame. use_metadata_tags is what makes the muxer write the
        // three -metadata values above as QuickTime keys; without it the MP4
        // muxer keeps only the handful it has a dedicated box for and silently
        // drops make and model.
        "-movflags".into(),
        "+faststart+use_metadata_tags".into(),
        "-f".into(),
        "mp4".into(),
    ]);
    args.push(out_path.to_string_lossy().into_owned());
    args
}

/// One frame, taken a moment in rather than at zero.
///
/// Frame zero is black on anything that fades in, and halfway is wrong for a
/// clip that ends on a title card, so a second in -- or the middle of anything
/// shorter than two seconds.
pub fn poster_args(video: &Path, out_path: &Path, duration: f64) -> Vec<String> {
    let offset = if duration > 0.0 {
        (duration / 2.0).min(1.0)
    } else {
        0.0
    };
    let mut args: Vec<String> = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(["-ss".into(), format!("{offset:.3}")]);
    args.push("-i".into());
    args.push(video.to_string_lossy().into_owned());
    args.extend([
        "-map".into(),
        "0:v:0".into(),
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "image2".into(),
        "-c:v".into(),
        "png".into(),
    ]);
    args.push(out_path.to_string_lossy().into_owned());
    args
}

fn run(args: &[String]) -> Result<std::process::Output> {
    Command::new(&args[0])
        .args(&args[1..])
        .output()
        .with_context(|| format!("{} could not be run", args[0]))
}

fn wrote_something(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

/// Takes the poster from the sanitised output, never from the source.
///
/// Two reasons, both structural: the poster then cannot show a frame the
/// published video does not contain, and it cannot carry EXIF that the strip
/// missed on the way past.
pub fn extract_poster(video: &Path, out_path: &Path, duration: f64) -> Result<()> {
    let first = run(&poster_args(video, out_path, duration))?;
    if first.status.success() && wrote_something(out_path) {
        return Ok(());
    }

    // A clip shorter than the seek offset yields no frame at all.
    let retry = run(&poster_args(video, out_path, 0.0))?;
    if retry.status.success() && wrote_something(out_path) {
        return Ok(());
    }
    bail!("no frame could be read for a poster")
}

/// Whether the file still starts playing before it finishes downloading.
///
/// Walks the top-level box list: 4-byte big-endian size, 4-byte type, with size
/// 1 meaning a 64-bit largesize follows and size 0 meaning "to the end".
pub fn moov_before_mdat(path: &Path) -> bool {
    let Ok(mut handle) = std::fs::File::open(path) else {
        return false;
    };
    let mut offset: u64 = 0;
    loop {
        if handle.seek(SeekFrom::Start(offset)).is_err() {
            return false;
        }
        let mut header = [0u8; 8];
        if handle.read_exact(&mut header).is_err() {
            return false;
        }
        let mut size = u64::from(u32::from_be_bytes(header[0..4].try_into().unwrap()));
        let kind = &header[4..8];

        if size == 1 {
            let mut largesize = [0u8; 8];
            if handle.read_exact(&mut largesize).is_err() {
                return false;
            }
            size = u64::from_be_bytes(largesize);
        } else if size == 0 {
            return kind == b"moov";
        }

        if kind == b"moov" {
            return true;
        }
        if kind == b"mdat" {
            return false;
        }
        if size < 8 {
            return false;
        }
        offset += size;
    }
}

/// Drops the language suffix a QuickTime key can carry.
///
/// The same value shows up twice, as `location` and `location-eng`, depending
/// on whether the atom named a language. Comparing the suffixed form against a
/// fixed list would flag our own decoy as a leak.
pub fn normalise_tag_key(key: &str) -> String {
    let lowered = key.to_lowercase();
    if let Some((head, suffix)) = lowered.rsplit_once('-') {
        if suffix.len() == 3 && suffix.chars().all(|c| c.is_ascii_alphabetic()) {
            return head.to_string();
        }
    }
    lowered
}

/// Tag keys ffprobe can still read that the output has no business carrying.
///
/// The concrete form of "ffprobe shows no original metadata": handler_name,
/// vendor_id, encoder and creation_time must all be gone, and requiring
/// `encoder` to say nothing versioned is what proves the bitexact flags did
/// something.
pub fn container_leaks(props: &VideoProperties) -> Vec<String> {
    let mut leaked: Vec<String> = Vec::new();

    for tags in std::iter::once(&props.format_tags).chain(props.stream_tags.iter()) {
        for (key, value) in tags {
            let name = normalise_tag_key(key);
            if ALLOWED_CONTAINER_TAGS.contains(&name.as_str()) {
                continue;
            }
            match muxer_constant_is_generic(&name, value) {
                // No date exemption even when decoyed: the transcode zeroes
                // every container date and the video decoy deliberately writes
                // none, so a creation_time here is one nothing in this pipeline
                // put there.
                Some(true) => continue,
                Some(false) => leaked.push(format!("{name}={value}")),
                None => leaked.push(name),
            }
        }
    }

    leaked.sort();
    leaked.dedup();
    leaked
}

/// What the transcode must have preserved, checked against what it did.
pub fn compare_properties(
    before: &VideoProperties,
    after: &VideoProperties,
    expected_width: u32,
    expected_height: u32,
) -> Vec<String> {
    let mut problems = Vec::new();

    let tolerance = (0.02 * before.duration).max(0.15);
    if (after.duration - before.duration).abs() > tolerance {
        problems.push(format!(
            "duration changed from {:.2}s to {:.2}s",
            before.duration, after.duration
        ));
    }

    if before.has_audio && !after.has_audio {
        problems.push("audio was dropped".into());
    }
    if after.has_audio && !before.has_audio {
        problems.push("audio appeared where the source had none".into());
    }
    if before.has_audio && after.has_audio && before.audio_channels != after.audio_channels {
        problems.push(format!(
            "audio channels changed from {:?} to {:?}",
            before.audio_channels, after.audio_channels
        ));
    }

    if (after.width, after.height) != (expected_width, expected_height) {
        problems.push(format!(
            "dimensions are {}x{}, expected {expected_width}x{expected_height}",
            after.width, after.height
        ));
    }
    if after.width > before.width || after.height > before.height {
        problems.push("upscaled beyond the source".into());
    }
    let ratio = |p: &VideoProperties| f64::from(p.width) / f64::from(p.height);
    if (ratio(after) - ratio(before)).abs() > 0.01 {
        problems.push("aspect ratio drifted from the source".into());
    }

    if after.video_codec != "h264" {
        let what = if after.video_codec.is_empty() {
            "nothing"
        } else {
            &after.video_codec
        };
        problems.push(format!("video is {what}, not H.264"));
    }
    if after.has_audio && after.audio_codec.as_deref() != Some("aac") {
        problems.push(format!("audio is {:?}, not AAC", after.audio_codec));
    }

    // A surviving display matrix means the pixels are not upright and the site
    // would have to rotate them itself.
    if after.rotation != 0 {
        problems.push(format!(
            "a {}-degree rotation survived into the output",
            after.rotation
        ));
    }

    problems
}

/// The two transfer functions a phone records HDR with.
const HDR_TRANSFERS: &[&str] = &["arib-std-b67", "smpte2084"];

fn is_hdr(props: &VideoProperties) -> bool {
    props
        .color_transfer
        .as_deref()
        .map(|transfer| HDR_TRANSFERS.contains(&transfer.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Whether the pixel format carries more than eight bits per component.
fn is_deep(pix_fmt: &str) -> bool {
    let lowered = pix_fmt.to_lowercase();
    ["10le", "10be", "12le", "12be", "16le", "16be"]
        .iter()
        .any(|depth| lowered.ends_with(depth))
}

/// What the author would see change, phrased for them rather than for a log.
///
/// This is the whole of the gate: a non-empty list here is what has the Worker
/// send the processed clip back for a final look instead of publishing it. So
/// the bar is deliberately what a person can *see*, not what a probe can
/// measure. A re-encode at CRF 20 typically lands at a third of a phone's
/// bitrate and looks the same, because CRF targets quality rather than size --
/// gating on that would ask a question about every video ever sent, and the task
/// asks for an optional confirmation, not a compulsory one.
///
/// Anything that fails `compare_properties` is not here: that is a broken
/// output, and a broken output fails the job rather than arriving as a question.
pub fn visible_changes(before: &VideoProperties, after: &VideoProperties) -> Vec<String> {
    let mut changes = Vec::new();

    if (after.width, after.height) != (before.width, before.height) {
        changes.push(format!(
            "scaled from {}x{} to {}x{}",
            before.width, before.height, after.width, after.height
        ));
    }

    // Two separate facts about the same clip, and a phone can produce either
    // without the other: HLG at eight bits, or ten-bit SDR from a pro camera.
    if is_hdr(before) && !is_hdr(after) {
        changes.push("high dynamic range flattened to standard range".into());
    }
    if is_deep(&before.pix_fmt) && !is_deep(&after.pix_fmt) {
        changes.push("10-bit colour reduced to 8-bit".into());
    }

    // Wider than muxer rounding, narrower than the tolerance compare_properties
    // fails on -- so a drift big enough to be a fault still fails the job, and
    // only the band between the two is worth a question.
    let noise = (0.01 * before.duration).max(0.25);
    if (after.duration - before.duration).abs() > noise {
        changes.push(format!(
            "{:.2}s became {:.2}s",
            before.duration, after.duration
        ));
    }

    changes
}

/// Whether the decoy location actually landed in the container.
///
/// Read back rather than trusted: a claimed decoy that is not there would have
/// the validation exempt a tag nothing wrote.
fn location_present(props: &VideoProperties) -> bool {
    props.format_tags.keys().any(|key| {
        let name = normalise_tag_key(key);
        name == "location" || name == "com.apple.quicktime.location.iso6709"
    })
}

pub fn derivatives(
    source: &Path,
    media_id: &str,
    work_dir: &Path,
    widths: &[u32],
    decoy: &Decoy,
    seed: u64,
    options: &Options,
) -> Outcome {
    let before = match probe(source) {
        Ok(props) => props,
        Err(err) => {
            return Outcome::failed(format!("{media_id}: not a video this can read: {err}"))
        }
    };

    let (expected_width, expected_height) = scaled_size(&before, options.video_max_width);
    let out_path = work_dir.join(format!("{media_id}-{expected_width}.mp4"));

    // Drawn once for the whole item, so the video and its poster claim the same
    // place.
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let peak = decoy.peak(&mut rng);
    let location = iso6709(peak.lat, peak.lon);

    let args = transcode_args(source, &out_path, &before, decoy, &location, options);
    let transcode = match run(&args) {
        Ok(output) => output,
        Err(err) => return Outcome::failed(format!("{media_id}: the transcode failed: {err}")),
    };
    if !transcode.status.success() || !out_path.exists() {
        let _ = std::fs::remove_file(&out_path);
        let stderr = String::from_utf8_lossy(&transcode.stderr);
        let detail = stderr
            .trim()
            .lines()
            .last()
            .unwrap_or("no output")
            .to_string();
        return Outcome::failed(format!("{media_id}: the transcode failed: {detail}"));
    }

    let after = match probe(&out_path) {
        Ok(props) => props,
        Err(err) => return Outcome::failed(format!("{media_id}: the output is unreadable: {err}")),
    };

    let mut failures: Vec<String> = Vec::new();
    let name = out_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    for problem in compare_properties(&before, &after, expected_width, expected_height) {
        failures.push(format!("{name}: {problem}"));
    }

    let leaked = container_leaks(&after);
    if !leaked.is_empty() {
        failures.push(format!("{name}: container metadata survived: {leaked:?}"));
    }

    // Nothing rewrites the file after the muxer any more, so a moov behind mdat
    // is a real fault rather than something to repair and move on from.
    if !moov_before_mdat(&out_path) {
        failures.push(format!(
            "{name}: moov landed behind mdat, so it will not stream"
        ));
    }

    let claimed = location_present(&after).then(|| peak.name.clone());
    let bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        failures.push(format!("{name}: written empty"));
    }

    let mut entry = Entry::picture(
        name,
        "mp4".into(),
        Role::Video,
        after.width,
        after.height,
        bytes,
    );
    entry.duration_seconds = Some((after.duration * 1000.0).round() / 1000.0);
    entry.has_audio = Some(after.has_audio);
    entry.decoy_location = claimed.clone();
    // Read off the same two probes the checks above used. This process is the
    // only one that ever holds both the original and the output, so it is the
    // only one that can say what the transcode did to the picture.
    entry.visible_changes = visible_changes(&before, &after);

    let mut outcome = Outcome {
        entries: vec![entry],
        failures,
        ..Default::default()
    };

    let poster = work_dir.join(format!("{media_id}-poster.png"));
    if let Err(err) = extract_poster(&out_path, &poster, after.duration) {
        outcome.failures.push(format!("{media_id}: {err}"));
        return outcome;
    }

    // The poster claims the same place as the video it stands for, or nothing
    // at all when the video's own decoy did not land.
    let pinned = claimed.is_some().then(|| peak.clone());
    let posters = image::derivatives(
        &poster,
        media_id,
        work_dir,
        widths,
        decoy,
        seed,
        Naming::poster(media_id, pinned),
    );
    // An intermediate, not a derivative: it must not reach the upload.
    let _ = std::fs::remove_file(&poster);

    outcome.entries.extend(posters.entries);
    outcome.failures.extend(posters.failures);
    outcome.skipped_formats.extend(posters.skipped_formats);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(width: u32, height: u32, has_audio: bool) -> VideoProperties {
        VideoProperties {
            width,
            height,
            duration: 1.0,
            video_codec: "h264".into(),
            has_audio,
            audio_codec: has_audio.then(|| "aac".to_string()),
            audio_channels: has_audio.then_some(1),
            pix_fmt: "yuv420p".into(),
            ..Default::default()
        }
    }

    fn sample_decoy() -> Decoy {
        serde_json::from_str(
            r#"{"camera":{"make":"Sony","model":"Alpha"},
                "dateTimeOriginal":{"date":"2117:03:03","randomizeTime":true},
                "gpsCandidates":[{"name":"Matterhorn","lat":45.9763,"lon":7.6586}]}"#,
        )
        .unwrap()
    }

    fn args_for(props: &VideoProperties, options: &Options) -> Vec<String> {
        transcode_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            props,
            &sample_decoy(),
            "+045.9763+007.6586/",
            options,
        )
    }

    #[test]
    fn a_silent_source_says_an_and_asks_for_no_audio_codec() {
        let args = args_for(&props(640, 480, false), &Options::default());
        assert!(args.contains(&"-an".to_string()));
        assert!(!args.contains(&"-c:a".to_string()));
        assert!(!args.contains(&"-map_metadata:s:a".to_string()));
    }

    #[test]
    fn a_source_within_the_cap_is_not_resized_at_all() {
        // "Avoid resize unless required", taken literally: no filter graph at
        // all, so no chroma resampling on a clip that did not need it.
        let args = args_for(&props(640, 480, true), &Options::default());
        assert!(!args.contains(&"-vf".to_string()));
    }

    #[test]
    fn an_oversized_source_gains_a_scale_filter_at_the_cap() {
        let args = args_for(&props(3840, 2160, true), &Options::default());
        let index = args
            .iter()
            .position(|a| a == "-vf")
            .expect("a scale filter");
        assert_eq!(args[index + 1], "scale=1920:1080:flags=lanczos");
    }

    #[test]
    fn the_decoy_and_the_muxer_flags_travel_in_the_same_invocation() {
        let args = args_for(&props(640, 480, true), &Options::default());

        // use_metadata_tags is what makes the muxer keep make and model at all.
        let index = args
            .iter()
            .position(|a| a == "-movflags")
            .expect("movflags");
        assert_eq!(args[index + 1], "+faststart+use_metadata_tags");
        // The Apple Keys namespace, which is what a phone clip carries.
        assert!(args.contains(&"com.apple.quicktime.make=Sony".to_string()));
        assert!(args.contains(&"com.apple.quicktime.model=Alpha".to_string()));
        assert!(
            args.contains(&"com.apple.quicktime.location.ISO6709=+045.9763+007.6586/".to_string())
        );

        // Both bitexact flags, which are what strip the encoder's version and
        // zero the container dates.
        assert!(args.contains(&"+bitexact".to_string()));
        assert!(args.contains(&"-fflags".to_string()));
    }

    #[test]
    fn no_date_is_offered_to_a_container_that_would_wrap_it() {
        let args = args_for(&props(640, 480, true), &Options::default()).join(" ");
        // 2117 in a 32-bit 1904 epoch comes back as 1981.
        assert!(!args.contains("creation_time"));
        assert!(!args.contains("2117"));
    }

    #[test]
    fn the_crf_and_preset_come_from_the_options() {
        let options = Options {
            video_crf: 27,
            video_preset: "ultrafast".into(),
            ..Options::default()
        };
        let args = args_for(&props(640, 480, true), &options);
        let crf = args.iter().position(|a| a == "-crf").unwrap();
        assert_eq!(args[crf + 1], "27");
        let preset = args.iter().position(|a| a == "-preset").unwrap();
        assert_eq!(args[preset + 1], "ultrafast");
    }

    #[test]
    fn scaling_forces_even_dimensions_because_yuv420p_cannot_hold_odd_ones() {
        // 1079 would round to an odd height.
        let (width, height) = scaled_size(&props(1920, 1079, false), 1280);
        assert_eq!(width % 2, 0);
        assert_eq!(height % 2, 0);
        assert_eq!(width, 1280);
    }

    #[test]
    fn a_source_at_the_cap_is_left_at_its_own_size() {
        assert_eq!(scaled_size(&props(1920, 1080, false), 1920), (1920, 1080));
        assert_eq!(scaled_size(&props(640, 480, false), 1920), (640, 480));
    }

    #[test]
    fn a_language_suffix_is_not_a_different_tag() {
        assert_eq!(normalise_tag_key("location-eng"), "location");
        assert_eq!(normalise_tag_key("LOCATION"), "location");
        // Not a language suffix: four letters, and a real key that ends in one.
        assert_eq!(normalise_tag_key("handler_name"), "handler_name");
        assert_eq!(normalise_tag_key("some-thing"), "some-thing");
    }

    #[test]
    fn a_versioned_encoder_is_a_leak_and_a_versionless_one_is_not() {
        assert_eq!(
            muxer_constant_is_generic("encoder", "Lavc libx264"),
            Some(true)
        );
        assert_eq!(
            muxer_constant_is_generic("encoder", "Lavc60.31.102 libx264"),
            Some(false)
        );
    }

    #[test]
    fn the_camera_handler_name_is_a_leak_and_the_muxers_is_not() {
        assert_eq!(
            muxer_constant_is_generic("handler_name", "VideoHandler"),
            Some(true)
        );
        assert_eq!(
            muxer_constant_is_generic("handler_name", "Core Media Video"),
            Some(false)
        );
        assert_eq!(
            muxer_constant_is_generic("vendor_id", "[0][0][0][0]"),
            Some(true)
        );
    }

    #[test]
    fn our_own_decoy_tags_are_not_reported_as_leaks() {
        let mut props = props(640, 480, true);
        props.format_tags = [
            ("major_brand", "isom"),
            ("make", "Sony"),
            ("model", "Alpha"),
            ("location", "+045.9763+007.6586/"),
            ("location-eng", "+045.9763+007.6586/"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        props.stream_tags = vec![[
            ("handler_name", "VideoHandler"),
            ("encoder", "Lavc libx264"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()];

        assert_eq!(container_leaks(&props), Vec::<String>::new());
    }

    #[test]
    fn a_phones_own_tags_are_reported_as_leaks() {
        let mut props = props(640, 480, true);
        props.format_tags = [
            ("com.apple.quicktime.software", "17.0"),
            ("creation_time", "2026-04-11T08:14:22Z"),
            ("comment", "sent from a phone"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

        let leaked = container_leaks(&props);
        assert!(leaked.contains(&"creation_time".to_string()), "{leaked:?}");
        assert!(leaked.contains(&"comment".to_string()), "{leaked:?}");
        assert!(
            leaked.contains(&"com.apple.quicktime.software".to_string()),
            "{leaked:?}"
        );
    }

    #[test]
    fn the_poster_is_taken_a_second_in_unless_the_clip_is_shorter() {
        let args = poster_args(Path::new("in.mp4"), Path::new("out.png"), 10.0);
        let index = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[index + 1], "1.000");

        // Halfway through anything shorter than two seconds.
        let short = poster_args(Path::new("in.mp4"), Path::new("out.png"), 0.5);
        let index = short.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(short[index + 1], "0.250");
    }

    #[test]
    fn a_dropped_audio_track_is_a_reported_problem() {
        let before = props(640, 480, true);
        let after = props(640, 480, false);
        let problems = compare_properties(&before, &after, 640, 480);
        assert!(
            problems.iter().any(|p| p == "audio was dropped"),
            "{problems:?}"
        );
    }

    #[test]
    fn a_surviving_rotation_matrix_is_a_reported_problem() {
        let before = props(480, 640, false);
        let mut after = props(480, 640, false);
        after.rotation = 90;
        let problems = compare_properties(&before, &after, 480, 640);
        assert!(
            problems.iter().any(|p| p.contains("rotation survived")),
            "{problems:?}"
        );
    }

    #[test]
    fn a_clean_transcode_reports_nothing() {
        let before = props(640, 480, true);
        let after = props(640, 480, true);
        assert_eq!(
            compare_properties(&before, &after, 640, 480),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_clip_that_came_through_at_its_own_size_and_depth_asks_nothing() {
        // The ordinary case, and the one that decides how often the author is
        // interrupted: an in-cap SDR clip is republished without a question.
        let before = props(1920, 1080, true);
        let after = props(1920, 1080, true);
        assert_eq!(visible_changes(&before, &after), Vec::<String>::new());
    }

    #[test]
    fn a_scaled_clip_says_what_it_was_and_what_it_became() {
        let before = props(3840, 2160, true);
        let after = props(1920, 1080, true);
        assert_eq!(
            visible_changes(&before, &after),
            vec!["scaled from 3840x2160 to 1920x1080"]
        );
    }

    #[test]
    fn flattened_hdr_and_reduced_depth_are_two_separate_answers() {
        let mut before = props(1920, 1080, true);
        before.color_transfer = Some("arib-std-b67".into());
        before.pix_fmt = "yuv420p10le".into();
        let after = props(1920, 1080, true);

        assert_eq!(
            visible_changes(&before, &after),
            vec![
                "high dynamic range flattened to standard range",
                "10-bit colour reduced to 8-bit",
            ]
        );

        // Either without the other: HLG at eight bits is what a phone writes,
        // ten-bit SDR is what a camera does.
        let mut hlg_only = props(1920, 1080, true);
        hlg_only.color_transfer = Some("smpte2084".into());
        assert_eq!(
            visible_changes(&hlg_only, &after),
            vec!["high dynamic range flattened to standard range"]
        );
    }

    #[test]
    fn an_ordinary_sdr_transfer_is_not_a_flattening() {
        let mut before = props(1920, 1080, true);
        before.color_transfer = Some("bt709".into());
        let mut after = props(1920, 1080, true);
        after.color_transfer = Some("bt709".into());
        assert_eq!(visible_changes(&before, &after), Vec::<String>::new());
    }

    #[test]
    fn a_duration_drift_is_reported_only_once_it_is_past_muxer_rounding() {
        let mut before = props(640, 480, true);
        before.duration = 60.0;

        let mut rounded = props(640, 480, true);
        rounded.duration = 60.1;
        assert_eq!(visible_changes(&before, &rounded), Vec::<String>::new());

        let mut trimmed = props(640, 480, true);
        trimmed.duration = 59.2;
        assert_eq!(
            visible_changes(&before, &trimmed),
            vec!["60.00s became 59.20s"]
        );
    }

    /// The band between the two has to be non-empty, or the gate can never fire
    /// on duration: anything wider fails the job before it is ever asked about.
    #[test]
    fn a_drift_worth_reporting_is_still_inside_what_the_job_tolerates() {
        let mut before = props(640, 480, true);
        before.duration = 60.0;
        let mut after = props(640, 480, true);
        after.duration = 59.2;

        assert!(!visible_changes(&before, &after).is_empty());
        assert_eq!(
            compare_properties(&before, &after, 640, 480),
            Vec::<String>::new()
        );
    }
}
