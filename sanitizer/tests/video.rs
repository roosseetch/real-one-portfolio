//! The video path: the matrix the task asks for, plus what it implies.
//!
//! The acceptance criteria are literally "ffprobe shows no original metadata,
//! duration and audio are preserved, a poster is generated", so each of those
//! is one assertion against a fixture that demonstrably started out the other
//! way.

mod common;

use common::{Scratch, VideoSpec};
use sanitize_media::manifest::Role;

/// Everything the fixture puts into a source, in the form the output must not
/// contain any of. Checking values rather than re-listing the allowed keys
/// keeps this independent of the sanitiser's own allowlist -- a list that grew
/// wrong would otherwise be checked against a copy of itself.
const SOURCE_TRACES: &[&str] = &[
    "Apple",
    "iPhone",
    "sent from a phone",
    "2026-04-11",
    "52.36",
    "4.90",
];

fn assert_no_source_traces(path: &std::path::Path) {
    let tags = common::probe_tags(path);
    let printed = tags
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(" ");
    for trace in SOURCE_TRACES {
        assert!(
            !printed.contains(trace),
            "{trace:?} survived into {path:?}: {printed}"
        );
    }

    // The three the MP4 muxer always writes. They cannot be removed, only made
    // to say nothing, so what matters is that they say the generic thing rather
    // than the camera's or the encoder's version.
    let handler = tags
        .get("handler_name")
        .cloned()
        .unwrap_or_else(|| "VideoHandler".into());
    assert!(
        ["VideoHandler", "SoundHandler", ""].contains(&handler.as_str()),
        "a camera's handler name survived: {handler}"
    );
    let vendor = tags
        .get("vendor_id")
        .cloned()
        .unwrap_or_else(|| "[0][0][0][0]".into());
    assert!(
        ["[0][0][0][0]", ""].contains(&vendor.as_str()),
        "a vendor id survived: {vendor}"
    );
    let encoder = tags
        .get("encoder")
        .cloned()
        .unwrap_or_else(|| "Lavc".into());
    let first = encoder.split_whitespace().next().unwrap_or("");
    assert!(
        !first.chars().any(|c| c.is_ascii_digit()),
        "a versioned encoder survived: {encoder}"
    );
}

fn clip(scratch: &Scratch, spec: VideoSpec) -> std::path::PathBuf {
    common::make_video(&scratch.path, spec)
}

fn sanitize(scratch: &Scratch, source: &std::path::Path, widths: &[u32]) -> common::Run {
    common::sanitize_one(
        scratch,
        source,
        "media0",
        "video",
        widths,
        common::fast_video_options(),
    )
}

#[test]
fn an_mp4_publishes_one_video_and_a_poster_set() {
    needs_ffmpeg!();
    let scratch = Scratch::new("mp4");
    let source = clip(&scratch, VideoSpec::default());
    let run = sanitize(&scratch, &source, &[1600, 800, 320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    let video = run.video("media0");
    assert!(video.file.ends_with(".mp4"));
    assert_eq!(video.has_audio, Some(true));

    let posters = run.by_role("media0", Role::Poster);
    assert!(posters.iter().any(|p| p.format == "webp"));
    let mut widths: Vec<u32> = posters
        .iter()
        .filter(|p| p.format == "webp")
        .map(|p| p.width)
        .collect();
    widths.sort_unstable();
    // The source is 640x480, so 1600 and 800 both clamp to 640.
    assert_eq!(widths, vec![320, 640]);
}

#[test]
fn no_original_container_metadata_survives() {
    needs_ffmpeg!();
    let scratch = Scratch::new("container");
    let source = clip(&scratch, VideoSpec::default());
    let before = common::probe_tags(&source);
    assert!(before.contains_key("encoder") || before.contains_key("handler_name"));

    let run = sanitize(&scratch, &source, &[320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    assert_no_source_traces(&run.file(run.video("media0")));
}

#[test]
fn a_mov_becomes_a_clean_mp4() {
    needs_ffmpeg!();
    let scratch = Scratch::new("mov");
    let source = clip(
        &scratch,
        VideoSpec {
            name: "clip.mov".into(),
            container: "mov".into(),
            ..Default::default()
        },
    );
    let run = sanitize(&scratch, &source, &[320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    let output = run.file(run.video("media0"));
    assert_no_source_traces(&output);
    // Whatever it arrived as, it leaves as an MP4: one container downstream,
    // rather than a second one for the site to have to reason about.
    assert_eq!(
        sanitize_media::video::probe(&output).unwrap().video_codec,
        "h264"
    );
}

#[test]
fn a_gps_tagged_clip_carries_the_decoy_or_nothing() {
    needs_ffmpeg!();
    let scratch = Scratch::new("gps");
    let source = clip(
        &scratch,
        VideoSpec {
            name: "located.mp4".into(),
            location: Some("+52.3676+004.9041/".into()),
            ..Default::default()
        },
    );
    let run = sanitize(&scratch, &source, &[320]);
    let decoy = common::decoy();

    assert_eq!(run.result.failures, Vec::<String>::new());
    let entry = run.video("media0");
    let tags = common::probe_tags(&run.file(entry));
    let written: String = tags
        .iter()
        .filter(|(k, _)| k.contains("location"))
        .map(|(_, v)| v.clone())
        .collect::<Vec<_>>()
        .join(" ");

    // The source was in Amsterdam. Whatever the output says, it must not say that.
    assert!(
        !written.contains("52.36") && !written.contains("4.90"),
        "got {written}"
    );

    match &entry.decoy_location {
        // Not injectable in this build: then there must be no location at all,
        // not a half-written one.
        None => assert!(written.is_empty(), "a half-written location: {written}"),
        Some(name) => {
            let peak = decoy
                .gps_candidates
                .iter()
                .find(|p| &p.name == name)
                .expect("a configured peak");
            assert!(
                written.contains(&format!("{:.2}", peak.lat)[..4]),
                "{written} does not name {}",
                peak.name
            );
            // The poster claims the same place as the video it stands for.
            let poster_places: std::collections::BTreeSet<_> = run
                .by_role("media0", Role::Poster)
                .iter()
                .map(|p| p.decoy_location.clone())
                .collect();
            assert_eq!(poster_places, [Some(name.clone())].into_iter().collect());
        }
    }
}

#[test]
fn no_date_is_claimed_because_the_container_cannot_hold_ours() {
    needs_ffmpeg!();
    let scratch = Scratch::new("nodate");
    let source = clip(&scratch, VideoSpec::default());
    let run = sanitize(&scratch, &source, &[320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    let tags = common::probe_tags(&run.file(run.video("media0")));
    // The configured decoy year is 2117, and an MP4 counts seconds from 1904 in
    // 32 bits -- it runs out in 2040. Writing it anyway does not fail, it
    // wraps, and the file comes out claiming 1981. Nothing is the honest answer.
    assert!(!tags.contains_key("creation_time"), "{tags:?}");
    let printed = tags.values().cloned().collect::<Vec<_>>().join(" ");
    assert!(!printed.contains("1981"), "{printed}");
}

#[test]
fn the_poster_still_carries_the_2117_stamp_that_exif_can_hold() {
    needs_ffmpeg!();
    needs_exiftool!();
    let scratch = Scratch::new("posterstamp");
    let source = clip(&scratch, VideoSpec::default());
    let run = sanitize(&scratch, &source, &[320]);
    let decoy = common::decoy();

    let poster = run
        .by_role("media0", Role::Poster)
        .into_iter()
        .find(|p| p.format == "webp")
        .expect("a webp poster");
    let tags = common::exif_tags(&run.file(poster));
    let taken = common::exif_value(&tags, "DateTimeOriginal").expect("a date on the poster");
    assert!(
        taken.starts_with(&decoy.date_time_original.date),
        "got {taken}"
    );
}

#[test]
fn duration_survives_the_transcode() {
    needs_ffmpeg!();
    let scratch = Scratch::new("duration");
    let source = clip(
        &scratch,
        VideoSpec {
            seconds: 2.0,
            ..Default::default()
        },
    );
    let run = sanitize(&scratch, &source, &[320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    let seconds = run.video("media0").duration_seconds.expect("a duration");
    assert!((seconds - 2.0).abs() <= 0.15, "got {seconds}s");
}

#[test]
fn a_silent_clip_stays_silent_rather_than_gaining_an_empty_track() {
    needs_ffmpeg!();
    let scratch = Scratch::new("silent");
    let source = clip(
        &scratch,
        VideoSpec {
            name: "silent.mp4".into(),
            audio: false,
            ..Default::default()
        },
    );
    let run = sanitize(&scratch, &source, &[320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    let entry = run.video("media0");
    assert_eq!(entry.has_audio, Some(false));
    assert_eq!(
        sanitize_media::video::probe(&run.file(entry))
            .unwrap()
            .audio_codec,
        None
    );
}

#[test]
fn an_oversized_source_is_scaled_to_the_cap() {
    needs_ffmpeg!();
    let scratch = Scratch::new("oversized");
    let source = clip(
        &scratch,
        VideoSpec {
            size: (3840, 2160),
            seconds: 0.5,
            ..Default::default()
        },
    );
    let run = sanitize(&scratch, &source, &[320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    let entry = run.video("media0");
    assert_eq!((entry.width, entry.height), (1920, 1080));
}

#[test]
fn a_rotated_source_comes_out_upright() {
    needs_ffmpeg!();
    let scratch = Scratch::new("rotated");
    let source = clip(
        &scratch,
        VideoSpec {
            size: (640, 480),
            rotation: Some(90),
            ..Default::default()
        },
    );
    let run = sanitize(&scratch, &source, &[320]);

    assert_eq!(run.result.failures, Vec::<String>::new());
    let entry = run.video("media0");
    // Portrait display dimensions, and no matrix left for the site to apply.
    assert_eq!((entry.width, entry.height), (480, 640));
    assert_eq!(
        sanitize_media::video::probe(&run.file(entry))
            .unwrap()
            .rotation,
        0
    );
}

#[test]
fn the_output_starts_playing_before_it_finishes_downloading() {
    needs_ffmpeg!();
    let scratch = Scratch::new("faststart");
    let source = clip(&scratch, VideoSpec::default());
    let run = sanitize(&scratch, &source, &[320]);

    assert!(sanitize_media::video::moov_before_mdat(
        &run.file(run.video("media0"))
    ));
}

#[test]
fn the_poster_is_a_picture_with_no_identifying_metadata() {
    needs_ffmpeg!();
    needs_exiftool!();
    let scratch = Scratch::new("posterclean");
    let source = clip(&scratch, VideoSpec::default());
    let run = sanitize(&scratch, &source, &[320]);

    let poster = run
        .by_role("media0", Role::Poster)
        .into_iter()
        .find(|p| p.format == "webp")
        .expect("a webp poster");
    let tags = common::exif_tags(&run.file(poster));
    for forbidden in ["SerialNumber", "Software", "UserComment", "HostComputer"] {
        assert!(
            !common::has_exif_tag(&tags, forbidden),
            "the poster kept {forbidden}"
        );
    }
}

#[test]
fn the_intermediate_poster_frame_is_not_left_behind() {
    needs_ffmpeg!();
    let scratch = Scratch::new("nopng");
    let source = clip(&scratch, VideoSpec::default());
    let run = sanitize(&scratch, &source, &[320]);

    // A PNG in here would be uploaded as a derivative nothing references.
    let strays: Vec<_> = std::fs::read_dir(&run.work_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".png"))
        .collect();
    assert_eq!(strays, Vec::<String>::new());
}

#[test]
fn a_file_that_is_not_a_video_fails_without_writing_one() {
    needs_ffmpeg!();
    let scratch = Scratch::new("notavideo");
    let originals = scratch.path.join("originals");
    std::fs::create_dir_all(&originals).unwrap();
    let source = originals.join("clip.mp4");
    std::fs::write(&source, "this is not a video").unwrap();

    let run = sanitize(&scratch, &source, &[320]);

    assert!(run.result.manifest.is_empty());
    assert!(run.result.failures.iter().any(|f| f.contains("media0")));
    assert!(!run.work_dir.join("media0-0.mp4").exists());
    let mp4s: Vec<_> = std::fs::read_dir(&run.work_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".mp4"))
        .collect();
    assert_eq!(mp4s, Vec::<String>::new());
}

#[test]
fn a_jpeg_named_like_a_video_fails_the_same_way() {
    needs_ffmpeg!();
    let scratch = Scratch::new("jpegnamedmp4");
    let originals = scratch.path.join("originals");
    std::fs::create_dir_all(&originals).unwrap();
    let source = originals.join("clip.mp4");
    image::RgbImage::from_pixel(320, 240, image::Rgb([10, 20, 30]))
        .save_with_format(&source, image::ImageFormat::Jpeg)
        .unwrap();

    let run = sanitize(&scratch, &source, &[320]);

    // ffprobe reads a still picture as a one-frame video, so without the
    // refusal this would transcode into a 0.04-second clip whose poster frame
    // is the picture itself.
    assert!(run.result.manifest.is_empty());
    let mp4s: Vec<_> = std::fs::read_dir(&run.work_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".mp4"))
        .collect();
    assert_eq!(mp4s, Vec::<String>::new());
}

#[test]
fn an_image_and_a_video_travel_in_one_manifest() {
    needs_ffmpeg!();
    let scratch = Scratch::new("both");
    let photo = common::make_photo(
        &scratch.path,
        common::PhotoSpec {
            name: "photo.jpg".into(),
            size: (800, 600),
            dirty: true,
        },
    );
    let video = clip(&scratch, VideoSpec::default());

    let mut mapping = serde_json::Map::new();
    mapping.insert(
        "media0".into(),
        serde_json::json!({"file": "photo.jpg", "type": "image"}),
    );
    mapping.insert(
        "media1".into(),
        serde_json::json!({"file": "clip.mp4", "type": "video"}),
    );
    let run = common::sanitize_mapping(
        &scratch,
        video.parent().unwrap(),
        mapping,
        &[800, 320],
        common::fast_video_options(),
    );
    let _ = photo;

    assert_eq!(run.result.failures, Vec::<String>::new());
    let image_roles: std::collections::BTreeSet<_> =
        run.entries("media0").iter().map(|e| e.role).collect();
    assert_eq!(image_roles, [Role::Image].into_iter().collect());
    let video_roles: std::collections::BTreeSet<_> =
        run.entries("media1").iter().map(|e| e.role).collect();
    assert_eq!(
        video_roles,
        [Role::Video, Role::Poster].into_iter().collect()
    );
}

/// The workflow's own verification runs exiftool over the published MP4. If
/// this program leaves something exiftool objects to, the job fails after the
/// author has already been told their draft is processing.
#[test]
fn exiftool_finds_nothing_identifying_in_the_published_video() {
    needs_ffmpeg!();
    needs_exiftool!();
    let scratch = Scratch::new("exiftoolvideo");
    let source = clip(
        &scratch,
        VideoSpec {
            location: Some("+52.3676+004.9041/".into()),
            ..Default::default()
        },
    );
    let run = sanitize(&scratch, &source, &[320]);

    let tags = common::exif_tags(&run.file(run.video("media0")));
    // The exact list .github/workflows/process-media.yml greps for.
    for forbidden in [
        "SerialNumber",
        "OwnerName",
        "Artist",
        "Copyright",
        "Software",
        "ImageDescription",
        "UserComment",
        "HostComputer",
    ] {
        assert!(
            !common::has_exif_tag(&tags, forbidden),
            "the workflow would reject this: kept {forbidden}"
        );
    }
}

/// The same allowlist `.github/workflows/process-media.yml` applies, kept here
/// so a change to one is caught against the other before a dispatch.
#[test]
fn every_surviving_container_tag_is_one_the_workflow_permits() {
    needs_ffmpeg!();
    let scratch = Scratch::new("allowlist");
    let source = clip(&scratch, VideoSpec::default());
    let run = sanitize(&scratch, &source, &[320]);

    const PERMITTED: &[&str] = &[
        "major_brand",
        "minor_version",
        "compatible_brands",
        "language",
        "handler_name",
        "vendor_id",
        "encoder",
        "make",
        "model",
        "location",
        "com.apple.quicktime.make",
        "com.apple.quicktime.model",
        "com.apple.quicktime.location.iso6709",
    ];

    let tags = common::probe_tags(&run.file(run.video("media0")));
    for key in tags.keys() {
        let name = sanitize_media::video::normalise_tag_key(key);
        assert!(
            PERMITTED.contains(&name.as_str()),
            "{name} is not on the workflow's allowlist"
        );
    }
}
