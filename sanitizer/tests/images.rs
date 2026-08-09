//! The photo path.
//!
//! Ported from the Python suite that guarded it, assertion for assertion, plus
//! the checks that only became possible once this program wrote its own EXIF
//! rather than shelling out for it.

mod common;

use common::{PhotoSpec, Scratch};
use sanitize_media::manifest::Role;
use sanitize_media::Options;

/// Everything the fixture puts into a source, in the form the output must not
/// contain any of. Checking values rather than re-listing the allowed keys
/// keeps this independent of the sanitiser's own allowlist -- a list that grew
/// wrong would otherwise be checked against a copy of itself.
const SOURCE_TRACES: &[&str] = &[
    "Canon",
    "EOS R6",
    "0123456789",
    "Darktable",
    "A Real Photographer",
    "a-real-laptop.local",
];

fn photo(scratch: &Scratch, size: (u32, u32)) -> std::path::PathBuf {
    common::make_photo(
        &scratch.path,
        PhotoSpec {
            size,
            ..Default::default()
        },
    )
}

#[test]
fn strips_everything_identifying() {
    needs_exiftool!();
    let scratch = Scratch::new("strips");
    let source = photo(&scratch, (1600, 1067));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[1600, 1200, 800, 320],
        Options::default(),
    );

    assert_eq!(run.result.failures, Vec::<String>::new());
    assert!(!run.entries("media0").is_empty());

    for entry in run.entries("media0") {
        let tags = common::exif_tags(&run.file(entry));
        for forbidden in [
            "SerialNumber",
            "OwnerName",
            "Artist",
            "Software",
            "UserComment",
            "HostComputer",
        ] {
            assert!(
                !common::has_exif_tag(&tags, forbidden),
                "{} kept {forbidden}",
                entry.file
            );
        }
    }
}

/// The strongest form of the claim: not "the tags we thought to name are gone"
/// but "no string the source carried appears anywhere exiftool can see".
#[test]
fn no_value_from_the_source_appears_anywhere_in_the_output() {
    needs_exiftool!();
    let scratch = Scratch::new("traces");
    let source = photo(&scratch, (800, 600));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[800],
        Options::default(),
    );

    assert_eq!(run.result.failures, Vec::<String>::new());
    for entry in run.entries("media0") {
        let tags = common::exif_tags(&run.file(entry));
        let printed = tags
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ");
        for trace in SOURCE_TRACES {
            assert!(
                !printed.contains(trace),
                "{trace:?} survived into {}: {printed}",
                entry.file
            );
        }
        // Amsterdam, where the fixture claims to have been taken.
        assert!(
            !printed.contains("52 deg 22"),
            "the source GPS survived: {printed}"
        );
    }
}

#[test]
fn writes_a_decoy_that_matches_the_configured_peaks() {
    needs_exiftool!();
    let scratch = Scratch::new("decoy");
    let source = photo(&scratch, (1600, 1067));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[1600, 800, 320],
        Options::default(),
    );
    let decoy = common::decoy();

    assert_eq!(run.result.failures, Vec::<String>::new());
    for entry in run.entries("media0") {
        let claimed = entry.decoy_location.as_deref().expect("a decoy location");
        let peak = decoy
            .gps_candidates
            .iter()
            .find(|p| p.name == claimed)
            .unwrap_or_else(|| panic!("{claimed} is not a configured peak"));

        let tags = common::exif_tags(&run.file(entry));
        let latitude = common::exif_value(&tags, "GPSLatitude").expect("a written latitude");
        // exiftool prints "45 deg 58' 34.68\" N"; the degrees are enough to
        // tell one Alpine peak from another.
        assert!(
            latitude.contains(&format!("{}", peak.lat.abs().trunc() as i64)),
            "{} says {latitude}, expected {}",
            entry.file,
            peak.lat
        );
        assert_eq!(
            common::exif_value(&tags, "Make").as_deref(),
            Some(decoy.camera.make.as_str())
        );
        assert_eq!(
            common::exif_value(&tags, "Model").as_deref(),
            Some(decoy.camera.model.as_str())
        );
    }
}

/// Every width of one photo is the same photo. This is the one behaviour that
/// deliberately differs from the Python: it drew a fresh peak per derivative,
/// so the 1600px file could claim a different mountain from the 800px beside
/// it, which a reader comparing two downloads can see.
#[test]
fn every_derivative_of_one_photo_claims_the_same_place() {
    let scratch = Scratch::new("one-place");
    let source = photo(&scratch, (1600, 1067));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[1600, 800, 320],
        Options::default(),
    );

    let claimed: std::collections::BTreeSet<_> = run
        .entries("media0")
        .iter()
        .map(|e| e.decoy_location.clone())
        .collect();
    assert_eq!(
        claimed.len(),
        1,
        "one photo claimed several places: {claimed:?}"
    );
}

#[test]
fn the_2117_stamp_is_written_because_exif_has_no_ceiling() {
    needs_exiftool!();
    let scratch = Scratch::new("stamp");
    let source = photo(&scratch, (400, 300));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[320],
        Options::default(),
    );
    let decoy = common::decoy();

    let entry = &run.entries("media0")[0];
    let tags = common::exif_tags(&run.file(entry));
    let taken = common::exif_value(&tags, "DateTimeOriginal").expect("a date");
    assert!(
        taken.starts_with(&decoy.date_time_original.date),
        "expected the configured {} stamp, got {taken}",
        decoy.date_time_original.date
    );
}

#[test]
fn emits_every_requested_width_at_or_below_the_source() {
    let scratch = Scratch::new("widths");
    let source = photo(&scratch, (1600, 1067));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[1600, 1200, 800, 320],
        Options::default(),
    );

    let mut widths: Vec<u32> = run
        .entries("media0")
        .iter()
        .filter(|e| e.format == "webp")
        .map(|e| e.width)
        .collect();
    widths.sort_unstable();
    assert_eq!(widths, vec![320, 800, 1200, 1600]);
}

#[test]
fn never_upscales_and_writes_one_file_per_clamped_width() {
    let scratch = Scratch::new("clamp");
    let source = photo(&scratch, (400, 300));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[1600, 1200, 800, 320],
        Options::default(),
    );

    let mut widths: Vec<u32> = run
        .entries("media0")
        .iter()
        .filter(|e| e.format == "webp")
        .map(|e| e.width)
        .collect();
    widths.sort_unstable();
    // 1600, 1200 and 800 all clamp to 400; 320 stands on its own.
    assert_eq!(widths, vec![320, 400]);
    assert_eq!(run.result.failures, Vec::<String>::new());
}

#[test]
fn keeps_the_aspect_ratio() {
    let scratch = Scratch::new("ratio");
    let source = photo(&scratch, (1600, 900));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[1600, 800, 320],
        Options::default(),
    );

    for entry in run.entries("media0") {
        let ratio = f64::from(entry.width) / f64::from(entry.height);
        assert!(
            (ratio - 1600.0 / 900.0).abs() < 0.01,
            "{} is {}x{}",
            entry.file,
            entry.width,
            entry.height
        );
    }
}

#[test]
fn composites_transparency_onto_white_rather_than_black() {
    let scratch = Scratch::new("alpha");
    let originals = scratch.path.join("originals");
    std::fs::create_dir_all(&originals).unwrap();
    let source = originals.join("logo.png");
    image::RgbaImage::from_pixel(400, 400, image::Rgba([0, 0, 0, 0]))
        .save(&source)
        .unwrap();

    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[400],
        Options::default(),
    );
    assert_eq!(run.result.failures, Vec::<String>::new());

    let written = run.work_dir.join("media0-400.webp");
    let decoded = image::ImageReader::open(&written)
        .unwrap()
        .decode()
        .unwrap()
        .to_rgb8();
    let pixel = decoded.get_pixel(10, 10);
    // Discarding alpha instead of blending would leave this black.
    assert!(
        pixel[0] > 250 && pixel[1] > 250 && pixel[2] > 250,
        "transparency landed on {pixel:?} rather than white"
    );
}

#[test]
fn marks_every_entry_with_its_role() {
    let scratch = Scratch::new("role");
    let source = photo(&scratch, (400, 300));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[320],
        Options::default(),
    );

    assert!(!run.entries("media0").is_empty());
    assert!(run.entries("media0").iter().all(|e| e.role == Role::Image));
}

#[test]
fn writes_both_formats_and_neither_is_empty() {
    let scratch = Scratch::new("formats");
    let source = photo(&scratch, (800, 600));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[800],
        Options::default(),
    );

    let formats: std::collections::BTreeSet<&str> = run
        .entries("media0")
        .iter()
        .map(|e| e.format.as_str())
        .collect();
    assert!(formats.contains("webp"), "WebP is required: {formats:?}");
    assert!(
        formats.contains("avif"),
        "AVIF should be written when the encoder is built in"
    );
    for entry in run.entries("media0") {
        assert!(entry.bytes > 0, "{} was written empty", entry.file);
        assert_eq!(
            std::fs::metadata(run.file(entry)).unwrap().len(),
            entry.bytes,
            "the manifest disagrees with the file on disk"
        );
    }
}

#[test]
fn reports_a_source_that_is_not_there() {
    let scratch = Scratch::new("missing");
    let originals = scratch.path.join("originals");
    std::fs::create_dir_all(&originals).unwrap();

    let mut mapping = serde_json::Map::new();
    mapping.insert(
        "media0".into(),
        serde_json::json!({"file": "gone.jpg", "type": "image"}),
    );
    let run = common::sanitize_mapping(&scratch, &originals, mapping, &[320], Options::default());

    assert!(run.result.manifest.is_empty());
    assert!(run
        .result
        .failures
        .iter()
        .any(|f| f.contains("media0") && f.contains("not found")));
}

#[test]
fn reports_a_file_that_is_not_a_picture() {
    let scratch = Scratch::new("notapicture");
    let originals = scratch.path.join("originals");
    std::fs::create_dir_all(&originals).unwrap();
    let source = originals.join("invoice.jpg");
    std::fs::write(&source, "this is not a JPEG").unwrap();

    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "image",
        &[320],
        Options::default(),
    );

    assert!(run.result.manifest.is_empty());
    assert!(run.result.failures.iter().any(|f| f.contains("media0")));
}

#[test]
fn a_mapping_without_a_type_is_refused_rather_than_assumed() {
    let scratch = Scratch::new("notype");
    let source = photo(&scratch, (400, 300));

    let mut mapping = serde_json::Map::new();
    mapping.insert(
        "media0".into(),
        serde_json::Value::String(source.file_name().unwrap().to_string_lossy().into_owned()),
    );
    let run = common::sanitize_mapping(
        &scratch,
        source.parent().unwrap(),
        mapping,
        &[320],
        Options::default(),
    );

    // The tolerant reading of a missing type is "image", and that is how an mp4
    // ends up in front of a picture decoder.
    assert!(run.result.manifest.is_empty());
    assert!(run
        .result
        .failures
        .iter()
        .any(|f| f.contains("needs both a file and a type")));
}

#[test]
fn an_unknown_type_is_refused() {
    let scratch = Scratch::new("unknowntype");
    let source = photo(&scratch, (400, 300));
    let run = common::sanitize_one(
        &scratch,
        &source,
        "media0",
        "audio",
        &[320],
        Options::default(),
    );

    assert!(run.result.manifest.is_empty());
    assert!(run
        .result
        .failures
        .iter()
        .any(|f| f.contains("unknown media type")));
}

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------

#[test]
fn main_returns_nonzero_when_a_source_fails() {
    let scratch = Scratch::new("cli-fail");
    let originals = scratch.path.join("originals");
    std::fs::create_dir_all(&originals).unwrap();
    std::fs::write(originals.join("invoice.jpg"), "this is not a JPEG").unwrap();
    let mapping = scratch.path.join("mapping.json");
    std::fs::write(
        &mapping,
        r#"{"media0": {"file": "invoice.jpg", "type": "image"}}"#,
    )
    .unwrap();

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_sanitize-media"))
        .arg(&originals)
        .arg(scratch.work_dir())
        .arg(&mapping)
        .args(["--widths", "320"])
        .arg("--decoy-config")
        .arg(common::repo_root().join("config").join("media-decoy.json"))
        .output()
        .unwrap();

    assert!(!out.status.success(), "a failed source must not exit zero");
    assert!(String::from_utf8_lossy(&out.stderr).contains("FAILURES"));
}

#[test]
fn main_succeeds_and_writes_a_manifest() {
    let scratch = Scratch::new("cli-ok");
    let source = photo(&scratch, (800, 600));
    let mapping = scratch.path.join("mapping.json");
    std::fs::write(
        &mapping,
        r#"{"media0": {"file": "photo.jpg", "type": "image"}}"#,
    )
    .unwrap();

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_sanitize-media"))
        .arg(source.parent().unwrap())
        .arg(scratch.work_dir())
        .arg(&mapping)
        .args(["--widths", "800,320"])
        .arg("--decoy-config")
        .arg(common::repo_root().join("config").join("media-decoy.json"))
        .output()
        .unwrap();

    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(stdout.contains("derivatives written to"), "{stdout}");
    assert!(stdout.contains("decoy@"), "{stdout}");

    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(scratch.work_dir().join("manifest.json")).unwrap(),
    )
    .unwrap();
    assert!(manifest["media0"].as_array().unwrap().len() >= 2);
}
