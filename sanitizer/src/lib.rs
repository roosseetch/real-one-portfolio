//! Sanitises source photos and videos into public web derivatives.
//!
//! Order matters and is not negotiable: every trace of the original metadata is
//! removed first, and only then is the configured decoy metadata injected. The
//! work happens entirely in a directory the caller supplies, so a raw original
//! never sits next to tracked files.
//!
//! Removal is by re-encode rather than by deletion. A picture is decoded to
//! pixels and written out again through an encoder that carries nothing across;
//! a video is transcoded to H.264/AAC with every metadata dictionary dropped.
//! Deleting tags from the original file would leave whatever the deleter did
//! not know to look for -- and for a video that is a great deal, since a phone
//! writes its clock, its model and its coordinates into places a tag editor
//! does not reach.

pub mod decoy;
pub mod exif;
pub mod image;
pub mod manifest;
pub mod video;

use anyhow::Result;
use rand::Rng;
use std::path::{Path, PathBuf};

use decoy::Decoy;
use manifest::{Entry, Manifest};

/// How a picture is asked for, and at what qualities.
///
/// AVIF is what the site asks for first, and WebP is what it falls back to for
/// a browser that cannot read one. Both are required: the site offers the AVIF
/// through a `<source>`, and a browser that has chosen a source does not fall
/// back to the `<img>` beside it when the file turns out not to be there. A
/// video's poster is the exception and gets no AVIF at all -- the `poster`
/// attribute takes a single URL and can never be given the choice.
///
/// High, and deliberately so. What reaches this program has already been
/// through one encoder -- Telegram compresses a photo before the Bot API will
/// serve it -- so the derivative is a second generation over a first, and at 82
/// the two losses stacked into something the author could see beside the
/// original in their chat. 95 puts the second generation below what a reader
/// can pick out, at roughly two to three times the bytes; the derivative of a
/// 1600px source goes from a couple of hundred kilobytes to something still
/// well inside what a photograph on a page is worth.
///
/// Raising these does nothing for a picture already published. The originals
/// expire out of the private bucket on the draft-retention lifecycle, so there
/// is nothing left to encode them from -- this is for what is published next.
pub const WEBP_QUALITY: f32 = 95.0;
pub const AVIF_QUALITY: f32 = 80.0;

#[derive(Debug, Clone)]
pub struct Options {
    pub widths: Vec<u32>,
    pub video_crf: u32,
    pub video_preset: String,
    pub video_max_width: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            widths: vec![1600, 1200, 800, 320],
            video_crf: 20,
            video_preset: "medium".into(),
            video_max_width: 1920,
        }
    }
}

/// What one entry in the mapping asks for.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MediaSpec {
    pub file: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Default)]
pub struct SanitizeResult {
    pub manifest: Manifest,
    pub failures: Vec<String>,
}

/// Turns every mapped original into its public derivatives.
///
/// Returns rather than exits, so a caller can inspect the failures without
/// catching a process exit or reading stdout.
pub fn sanitize(
    source_dir: &Path,
    work_dir: &Path,
    mapping: &serde_json::Map<String, serde_json::Value>,
    decoy: &Decoy,
    options: &Options,
    rng: &mut impl Rng,
) -> Result<SanitizeResult> {
    std::fs::create_dir_all(work_dir)?;

    // Widest first, and each width only once.
    let mut widths: Vec<u32> = options.widths.clone();
    widths.sort_unstable_by(|a, b| b.cmp(a));
    widths.dedup();

    let mut result = SanitizeResult::default();

    for (media_id, spec) in mapping {
        // Strict rather than tolerant of a bare filename: the tolerant reading
        // of a missing type is "image", and handing an mp4 to an image decoder
        // is precisely the failure this whole task exists to remove.
        let spec: MediaSpec = match serde_json::from_value(spec.clone()) {
            Ok(spec) => spec,
            Err(_) => {
                result
                    .failures
                    .push(format!("{media_id}: mapping needs both a file and a type"));
                continue;
            }
        };

        let source: PathBuf = source_dir.join(&spec.file);
        if !source.exists() {
            result
                .failures
                .push(format!("{media_id}: source {} not found", spec.file));
            continue;
        }

        // Each item draws its own seed, so a video and its poster claim the
        // same place while remaining independent of how many derivatives some
        // earlier item happened to write.
        let seed: u64 = rng.gen();

        let outcome = match spec.kind.as_str() {
            "image" => image::derivatives(
                &source,
                media_id,
                work_dir,
                &widths,
                decoy,
                seed,
                image::Naming::image(media_id),
            ),
            "video" => {
                video::derivatives(&source, media_id, work_dir, &widths, decoy, seed, options)
            }
            other => Outcome::failed(format!("{media_id}: unknown media type {other:?}")),
        };

        result.failures.extend(outcome.failures);
        if !outcome.entries.is_empty() {
            result.manifest.insert(media_id.clone(), outcome.entries);
        }
    }

    let json = serde_json::to_string_pretty(&result.manifest)? + "\n";
    std::fs::write(work_dir.join("manifest.json"), json)?;
    Ok(result)
}

/// What one source produced, and everything that went wrong producing it.
#[derive(Debug, Default)]
pub struct Outcome {
    pub entries: Vec<Entry>,
    pub failures: Vec<String>,
}

impl Outcome {
    pub fn failed(reason: String) -> Self {
        Self {
            failures: vec![reason],
            ..Default::default()
        }
    }
}
