//! Fixtures for the media sanitiser's tests.
//!
//! Every input is built here at test time rather than committed. A checked-in
//! JPEG with real GPS in it is a privacy problem in a repository whose whole
//! point is that originals never touch git, and a checked-in MP4 is a binary
//! nobody can review.
//!
//! Each builder asserts that the file it produced is *dirty* before handing it
//! over. Without that, "no GPS survived" passes on a file that never had any --
//! which is the way a metadata test fails silently rather than loudly.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use sanitize_media::decoy::Decoy;

/// A developer's machine may lack exiftool or an ffmpeg with libx264, and the
/// suite reports what it cannot run there. In CI and in the container a skip
/// would be a hole that looks exactly like a pass, so the guards fail instead.
pub fn required() -> bool {
    std::env::var("MEDIA_TESTS_REQUIRED").as_deref() == Ok("1")
}

pub fn have(tool: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(tool).is_file()))
        .unwrap_or(false)
}

pub fn have_libx264() -> bool {
    if !have("ffmpeg") {
        return false;
    }
    Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(" libx264 "))
        .unwrap_or(false)
}

/// Returns false when the test should bow out. Panics instead when the suite
/// has been told that every tool is present.
pub fn available(condition: bool, what: &str) -> bool {
    if condition {
        return true;
    }
    if required() {
        panic!("{what} is required when MEDIA_TESTS_REQUIRED=1 and is not available");
    }
    eprintln!("skipping: {what} is not available on this machine");
    false
}

/// Bows out of a test unless ffmpeg, ffprobe and libx264 are all present.
#[macro_export]
macro_rules! needs_ffmpeg {
    () => {
        if !common::available(
            common::have("ffmpeg") && common::have("ffprobe"),
            "ffmpeg and ffprobe",
        ) {
            return;
        }
        // libopenh264 accepts neither -crf nor -preset, so a build without
        // libx264 would not fail over -- it would produce something else.
        if !common::available(common::have_libx264(), "an ffmpeg built with libx264") {
            return;
        }
    };
}

/// Bows out of a test unless exiftool is present.
///
/// The sanitiser does not use exiftool. These tests do, on purpose: it is an
/// implementation that shares no code with ours, so it can catch a bug that our
/// own reader would agree with.
#[macro_export]
macro_rules! needs_exiftool {
    () => {
        if !common::available(common::have("exiftool"), "exiftool") {
            return;
        }
    };
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

pub fn decoy() -> Decoy {
    Decoy::load(&repo_root().join("config").join("media-decoy.json")).expect("the decoy config")
}

pub fn run(args: &[&str]) -> String {
    let out = Command::new(args[0])
        .args(&args[1..])
        .output()
        .unwrap_or_else(|err| panic!("{} could not be run: {err}", args[0]));
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        panic!(
            "{} failed: {}",
            args[0],
            &stderr[stderr.len().saturating_sub(800)..]
        );
    }
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Every container and stream tag ffprobe can read, flattened and lowercased.
pub fn probe_tags(path: &Path) -> BTreeMap<String, String> {
    let out = run(&[
        "ffprobe",
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        &path.to_string_lossy(),
    ]);
    let probed: serde_json::Value = serde_json::from_str(&out).expect("ffprobe json");

    let mut tags = BTreeMap::new();
    let mut absorb = |node: &serde_json::Value| {
        if let Some(map) = node.get("tags").and_then(|t| t.as_object()) {
            for (key, value) in map {
                let text = match value {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                tags.insert(key.to_lowercase(), text);
            }
        }
    };
    if let Some(format) = probed.get("format") {
        absorb(format);
    }
    if let Some(streams) = probed.get("streams").and_then(|s| s.as_array()) {
        for stream in streams {
            absorb(stream);
        }
    }
    tags
}

/// What exiftool makes of a file, group-prefixed as `EXIF:Make`.
///
/// The independent oracle. Our own EXIF writer and our own EXIF reader would
/// happily agree with each other about a malformed block; this will not.
pub fn exif_tags(path: &Path) -> BTreeMap<String, String> {
    let out = run(&["exiftool", "-json", "-G", &path.to_string_lossy()]);
    let parsed: serde_json::Value = serde_json::from_str(&out).expect("exiftool json");
    parsed[0]
        .as_object()
        .expect("one object per file")
        .iter()
        .map(|(key, value)| {
            let text = match value {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            (key.clone(), text)
        })
        .collect()
}

/// The value of a tag whatever group exiftool filed it under.
pub fn exif_value(tags: &BTreeMap<String, String>, tag: &str) -> Option<String> {
    tags.iter()
        .find(|(key, _)| key.rsplit(':').next() == Some(tag))
        .map(|(_, value)| value.clone())
}

pub fn has_exif_tag(tags: &BTreeMap<String, String>, tag: &str) -> bool {
    exif_value(tags, tag).is_some()
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

pub struct PhotoSpec {
    pub name: String,
    pub size: (u32, u32),
    pub dirty: bool,
}

impl Default for PhotoSpec {
    fn default() -> Self {
        Self {
            name: "photo.jpg".into(),
            size: (1600, 1067),
            dirty: true,
        }
    }
}

/// A JPEG carrying everything a real camera would put in one.
pub fn make_photo(dir: &Path, spec: PhotoSpec) -> PathBuf {
    let originals = dir.join("originals");
    std::fs::create_dir_all(&originals).unwrap();
    let path = originals.join(&spec.name);

    // A flat colour compresses to almost nothing, which would make a "the
    // derivative is not empty" assertion vacuous. A gradient does not.
    let mut canvas = image::RgbImage::new(spec.size.0, spec.size.1);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        *pixel = image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]);
    }
    let mut encoded = Vec::new();
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Jpeg,
        )
        .unwrap();

    if spec.dirty {
        let exif = sanitize_media::exif::ExifBlock::dirty_fixture().to_tiff();
        encoded = sanitize_media::exif::jpeg_with_exif(&encoded, &exif).unwrap();
    }
    std::fs::write(&path, &encoded).unwrap();

    if spec.dirty && have("exiftool") {
        let tags = exif_tags(&path);
        assert!(
            has_exif_tag(&tags, "SerialNumber"),
            "the fixture must start dirty: {tags:?}"
        );
        assert!(
            has_exif_tag(&tags, "GPSLatitude"),
            "the fixture must start dirty: {tags:?}"
        );
    }
    path
}

pub struct VideoSpec {
    pub name: String,
    pub size: (u32, u32),
    pub seconds: f64,
    pub audio: bool,
    pub container: String,
    pub location: Option<String>,
    pub rotation: Option<i32>,
}

impl Default for VideoSpec {
    fn default() -> Self {
        Self {
            name: "clip.mp4".into(),
            size: (640, 480),
            seconds: 1.0,
            audio: true,
            container: "mp4".into(),
            location: None,
            rotation: None,
        }
    }
}

/// A short clip with the metadata a phone writes into one.
pub fn make_video(dir: &Path, spec: VideoSpec) -> PathBuf {
    let originals = dir.join("originals");
    std::fs::create_dir_all(&originals).unwrap();
    let path = originals.join(&spec.name);
    let target = path.to_string_lossy().into_owned();

    let source = format!(
        "testsrc=size={}x{}:rate=24:duration={}",
        spec.size.0, spec.size.1, spec.seconds
    );
    let sine = format!("sine=frequency=440:duration={}", spec.seconds);

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
    args.extend(["-f".into(), "lavfi".into(), "-i".into(), source]);
    if spec.audio {
        args.extend(["-f".into(), "lavfi".into(), "-i".into(), sine]);
    }
    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ]);
    if spec.audio {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "64k".into()]);
    }
    args.extend([
        "-metadata".into(),
        "make=Apple".into(),
        "-metadata".into(),
        "model=iPhone 15 Pro".into(),
        "-metadata".into(),
        "comment=sent from a phone".into(),
        "-metadata".into(),
        "creation_time=2026-04-11T08:14:22Z".into(),
    ]);
    if let Some(location) = &spec.location {
        args.extend(["-metadata".into(), format!("location={location}")]);
    }
    // Without this the MP4 muxer keeps only the handful of keys it has a box
    // for and silently drops make, model and location -- which would leave the
    // fixture clean of exactly what it exists to be dirty with. It is also how
    // a phone writes them: as QuickTime keys.
    args.extend([
        "-movflags".into(),
        "use_metadata_tags".into(),
        "-f".into(),
        spec.container.clone(),
        target.clone(),
    ]);
    run(&args.iter().map(String::as_str).collect::<Vec<_>>());

    if let Some(rotation) = spec.rotation {
        // Written as a display matrix on a remux, which is how a phone records
        // it: the pixels stay landscape and a matrix says to turn them.
        // Encoding with the rotation set instead would bake it into the pixels
        // and leave nothing for the sanitiser to have to handle.
        let rotated = originals.join(format!("rotated-{}", spec.name));
        let rotated_target = rotated.to_string_lossy().into_owned();
        run(&[
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-display_rotation",
            &rotation.to_string(),
            "-i",
            &target,
            "-map",
            "0",
            "-c",
            "copy",
            "-map_metadata",
            "0",
            // Or this pass drops the very tags the fixture exists to carry.
            "-movflags",
            "use_metadata_tags",
            "-f",
            &spec.container,
            &rotated_target,
        ]);
        std::fs::rename(&rotated, &path).unwrap();

        let probed: serde_json::Value = serde_json::from_str(&run(&[
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            &target,
        ]))
        .unwrap();
        let has_matrix = probed["streams"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|s| {
                s.get("side_data_list")
                    .and_then(|l| l.as_array())
                    .cloned()
                    .unwrap_or_default()
            })
            .any(|side| side.get("rotation").is_some());
        assert!(
            has_matrix,
            "the rotated fixture must actually carry a display matrix"
        );
    }

    let tags = probe_tags(&path);
    assert!(
        tags.contains_key("model") || tags.contains_key("com.apple.quicktime.model"),
        "the fixture must start dirty: {tags:?}"
    );
    assert!(
        tags.contains_key("encoder") || tags.contains_key("handler_name"),
        "the fixture must start dirty: {tags:?}"
    );
    if spec.location.is_some() {
        assert!(
            tags.keys().any(|k| k.contains("location")),
            "the location fixture must carry a location: {tags:?}"
        );
    }
    path
}

// ---------------------------------------------------------------------------
// Driving the sanitiser
// ---------------------------------------------------------------------------

/// A scratch directory that cleans itself up.
pub struct Scratch {
    pub path: PathBuf,
}

impl Scratch {
    pub fn new(label: &str) -> Self {
        let unique = format!(
            "{label}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir()
            .join("sanitize-media-tests")
            .join(unique);
        std::fs::create_dir_all(path.join("public")).unwrap();
        Self { path }
    }

    pub fn work_dir(&self) -> PathBuf {
        self.path.join("public")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub struct Run {
    pub result: sanitize_media::SanitizeResult,
    pub work_dir: PathBuf,
}

impl Run {
    pub fn entries(&self, media_id: &str) -> &[sanitize_media::manifest::Entry] {
        self.result
            .manifest
            .get(media_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn by_role(
        &self,
        media_id: &str,
        role: sanitize_media::manifest::Role,
    ) -> Vec<&sanitize_media::manifest::Entry> {
        self.entries(media_id)
            .iter()
            .filter(|e| e.role == role)
            .collect()
    }

    pub fn video(&self, media_id: &str) -> &sanitize_media::manifest::Entry {
        self.by_role(media_id, sanitize_media::manifest::Role::Video)
            .into_iter()
            .next()
            .expect("a video entry")
    }

    pub fn file(&self, entry: &sanitize_media::manifest::Entry) -> PathBuf {
        self.work_dir.join(&entry.file)
    }
}

/// Runs the sanitiser over one source, with a fixed seed so a failure is
/// reproducible.
pub fn sanitize_one(
    scratch: &Scratch,
    source: &Path,
    media_id: &str,
    kind: &str,
    widths: &[u32],
    options: sanitize_media::Options,
) -> Run {
    let mut mapping = serde_json::Map::new();
    mapping.insert(
        media_id.to_string(),
        serde_json::json!({
            "file": source.file_name().unwrap().to_string_lossy(),
            "type": kind,
        }),
    );
    sanitize_mapping(scratch, source.parent().unwrap(), mapping, widths, options)
}

pub fn sanitize_mapping(
    scratch: &Scratch,
    source_dir: &Path,
    mapping: serde_json::Map<String, serde_json::Value>,
    widths: &[u32],
    options: sanitize_media::Options,
) -> Run {
    use rand::SeedableRng;

    let work_dir = scratch.work_dir();
    let options = sanitize_media::Options {
        widths: widths.to_vec(),
        ..options
    };
    let mut rng = rand::rngs::StdRng::seed_from_u64(11);
    let result = sanitize_media::sanitize(
        source_dir,
        &work_dir,
        &mapping,
        &decoy(),
        &options,
        &mut rng,
    )
    .expect("the sanitiser must not fail outright");
    Run { result, work_dir }
}

/// The options the video tests use: ultrafast, because these clips exist to be
/// inspected rather than watched.
pub fn fast_video_options() -> sanitize_media::Options {
    sanitize_media::Options {
        video_preset: "ultrafast".into(),
        ..Default::default()
    }
}
