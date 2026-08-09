//! Every web derivative of one picture, checked as it is written.
//!
//! The pixels make exactly one trip: decoded, turned upright, flattened,
//! resized once per width, then handed to two encoders. Nothing from the
//! source file travels with them -- the encoders are given a pixel buffer and
//! an EXIF block this program built, and have no access to anything else.

use anyhow::{bail, Context, Result};
use image::{DynamicImage, Rgb, RgbImage};
use rand::SeedableRng;
use rayon::prelude::*;
use std::path::{Path, PathBuf};

use crate::decoy::{Decoy, Peak};
use crate::exif::{webp_with_exif, ExifBlock};
use crate::manifest::{Entry, Role};
use crate::{Outcome, AVIF_QUALITY, WEBP_QUALITY};

/// rav1e trades encode time against size on a steep curve. 6 keeps a 1600px
/// derivative inside a second or so on a runner while staying well under the
/// WebP it sits beside; lower spends minutes to save a few kilobytes nobody
/// downloads twice.
const AVIF_SPEED: u8 = 6;

/// How the outputs of one item are named and labelled.
///
/// The stem overrides the filename without changing which media id the entries
/// belong to, which is how a video's poster comes out as
/// `{media_id}-poster-{width}.webp` while still travelling with its video.
#[derive(Debug, Clone)]
pub struct Naming {
    pub stem: String,
    pub role: Role,
    /// Pinned for a poster, so it claims the same place as the video it stands
    /// for. Drawn from the seed when absent.
    pub peak: Option<Peak>,
}

impl Naming {
    pub fn image(media_id: &str) -> Self {
        Self {
            stem: media_id.to_string(),
            role: Role::Image,
            peak: None,
        }
    }

    pub fn poster(media_id: &str, peak: Option<Peak>) -> Self {
        Self {
            stem: format!("{media_id}-poster"),
            role: Role::Poster,
            peak,
        }
    }
}

/// Applies the orientation flag, then leaves it behind.
///
/// The pixels come out already the right way up, so writing no orientation tag
/// afterwards is correct rather than lossy. A reader that ignores EXIF now
/// agrees with one that does not.
fn upright(img: DynamicImage, orientation: u16) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        // Mirrored across the main diagonal.
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        // Mirrored across the anti-diagonal.
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn orientation_of(bytes: &[u8]) -> u16 {
    let mut cursor = std::io::Cursor::new(bytes);
    exif::Reader::new()
        .read_from_container(&mut cursor)
        .ok()
        .and_then(|parsed| {
            parsed
                .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .map(|value| value as u16)
        .unwrap_or(1)
}

/// Composites transparency onto white before the alpha channel is dropped.
///
/// Converting straight to RGB does not blend -- it discards the alpha and keeps
/// whatever colour sat under it, which is black almost everywhere it matters. A
/// WebP nearly always carries an alpha channel, so without this the format the
/// intake was widened to accept publishes with black where it should be clear.
fn flatten(img: &DynamicImage) -> RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }

    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u32::from(pixel[3]);
        let over_white = |channel: u8| -> u8 {
            ((u32::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8
        };
        out.put_pixel(
            x,
            y,
            Rgb([
                over_white(pixel[0]),
                over_white(pixel[1]),
                over_white(pixel[2]),
            ]),
        );
    }
    out
}

fn resize(source: &RgbImage, width: u32, height: u32) -> Result<Vec<u8>> {
    use fast_image_resize::images::Image as FirImage;
    use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

    let src = FirImage::from_vec_u8(
        source.width(),
        source.height(),
        source.as_raw().clone(),
        PixelType::U8x3,
    )?;
    let mut dst = FirImage::new(width, height, PixelType::U8x3);
    Resizer::new().resize(
        &src,
        &mut dst,
        &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
    )?;
    Ok(dst.into_vec())
}

fn write_webp(path: &Path, pixels: &[u8], width: u32, height: u32, exif: &[u8]) -> Result<()> {
    let encoded = webp::Encoder::from_rgb(pixels, width, height).encode(WEBP_QUALITY);
    let with_exif = webp_with_exif(&encoded, exif, width, height)?;
    std::fs::write(path, with_exif)?;
    Ok(())
}

fn write_avif(path: &Path, pixels: &[u8], width: u32, height: u32, exif: &[u8]) -> Result<()> {
    use rgb::FromSlice;

    let img = imgref::Img::new(pixels.as_rgb(), width as usize, height as usize);
    let encoded = ravif::Encoder::new()
        .with_quality(AVIF_QUALITY)
        .with_speed(AVIF_SPEED)
        .with_exif(exif.to_vec())
        .encode_rgb(img)?;
    std::fs::write(path, encoded.avif_file)?;
    Ok(())
}

/// Tags that surviving into an output would be a failure, not a warning.
///
/// The decoy's own Make, Model, DateTimeOriginal and GPS are not here: they are
/// what this program wrote on purpose. Everything else identifies a camera, a
/// person, or an editing session.
const FORBIDDEN: &[(exif::Tag, &str)] = &[
    (exif::Tag::BodySerialNumber, "SerialNumber"),
    (exif::Tag::LensSerialNumber, "LensSerialNumber"),
    (exif::Tag::CameraOwnerName, "OwnerName"),
    (exif::Tag::Artist, "Artist"),
    (exif::Tag::Copyright, "Copyright"),
    (exif::Tag::DateTime, "ModifyDate"),
    (exif::Tag::DateTimeDigitized, "CreateDate"),
    (exif::Tag::Software, "Software"),
    // By number: this parser has no constant for it, and a machine's hostname
    // is one of the more directly identifying things a photo can carry.
    (exif::Tag(exif::Context::Tiff, 0x013C), "HostComputer"),
    (exif::Tag::ImageDescription, "ImageDescription"),
    (exif::Tag::UserComment, "UserComment"),
];

/// Reads a written derivative back and reports anything identifying in it.
///
/// Best-effort by design: a container this parser cannot open yields no
/// findings rather than a failure, because the file was built from decoded
/// pixels and an EXIF block from this process -- there is no path by which
/// source metadata could be in it. The check earns its place against the
/// opposite mistake, a future edit that starts copying something across.
fn identifying_tags(path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut cursor = std::io::Cursor::new(&bytes);
    let Ok(parsed) = exif::Reader::new().read_from_container(&mut cursor) else {
        return Vec::new();
    };

    FORBIDDEN
        .iter()
        .filter(|(tag, _)| {
            parsed.get_field(*tag, exif::In::PRIMARY).is_some()
                || parsed.get_field(*tag, exif::In::THUMBNAIL).is_some()
        })
        .map(|(_, name)| (*name).to_string())
        .collect()
}

struct Written {
    entry: Entry,
    failures: Vec<String>,
}

/// What every derivative of one picture has in common.
struct Shared<'a> {
    exif: &'a [u8],
    role: Role,
    peak_name: &'a str,
    source_width: u32,
    source_ratio: f64,
}

/// The one derivative about to be written.
struct Target<'a> {
    out_path: PathBuf,
    extension: &'a str,
    pixels: &'a [u8],
    width: u32,
    height: u32,
}

/// One format at one width, written and then checked.
fn write_one(target: Target<'_>, shared: &Shared<'_>) -> Result<Written> {
    let Target {
        out_path,
        extension,
        pixels,
        width,
        height,
    } = target;

    match extension {
        "webp" => write_webp(&out_path, pixels, width, height, shared.exif)?,
        "avif" => write_avif(&out_path, pixels, width, height, shared.exif)?,
        other => bail!("no encoder for {other}"),
    }

    let name = out_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut failures = Vec::new();

    let leaked = identifying_tags(&out_path);
    if !leaked.is_empty() {
        failures.push(format!("{name}: original metadata survived: {leaked:?}"));
    }

    // A derivative wider than its source would be an upscale, and one that lost
    // its shape would crop the subject out on the site.
    if width > shared.source_width {
        failures.push(format!("{name}: upscaled beyond the source width"));
    }
    if (f64::from(width) / f64::from(height) - shared.source_ratio).abs() > 0.01 {
        failures.push(format!("{name}: aspect ratio drifted from the source"));
    }

    let bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        failures.push(format!("{name}: written empty"));
    }

    let mut entry = Entry::picture(
        name,
        extension.to_string(),
        shared.role,
        width,
        height,
        bytes,
    );
    entry.decoy_location = Some(shared.peak_name.to_string());
    Ok(Written { entry, failures })
}

/// Every web derivative of one picture.
pub fn derivatives(
    source: &Path,
    media_id: &str,
    work_dir: &Path,
    widths: &[u32],
    decoy: &Decoy,
    seed: u64,
    naming: Naming,
) -> Outcome {
    match try_derivatives(source, work_dir, widths, decoy, seed, naming) {
        Ok(outcome) => outcome,
        Err(err) => Outcome::failed(format!(
            "{media_id}: could not open {}: {err}",
            source
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        )),
    }
}

fn try_derivatives(
    source: &Path,
    work_dir: &Path,
    widths: &[u32],
    decoy: &Decoy,
    seed: u64,
    naming: Naming,
) -> Result<Outcome> {
    let bytes = std::fs::read(source).context("unreadable")?;
    let decoded = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .context("unrecognised format")?
        .decode()
        .context("not a picture this can read")?;

    let upright = upright(decoded, orientation_of(&bytes));
    let flat = flatten(&upright);
    drop(upright);

    let source_width = flat.width();
    let source_height = flat.height();
    if source_width == 0 || source_height == 0 {
        bail!("no usable dimensions");
    }
    let source_ratio = f64::from(source_width) / f64::from(source_height);

    // Drawn once for the whole picture, not once per derivative. Every width of
    // one photo is the same photo, and a 1600px file claiming a different
    // mountain from the 800px beside it is a contradiction a reader can see.
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let peak = naming.peak.clone().unwrap_or_else(|| decoy.peak(&mut rng));
    let taken_at = decoy.taken_at(&mut rng);
    let exif = ExifBlock::decoy(decoy, &peak, &taken_at).to_tiff();

    // Each requested width clamps to the source; two that land on the same size
    // are one file, because a derivative wider than its source is a bigger file
    // with no more detail in it.
    let mut targets: Vec<u32> = Vec::new();
    for width in widths {
        let actual = (*width).min(source_width);
        if !targets.contains(&actual) {
            targets.push(actual);
        }
    }

    let results: Vec<(Vec<Written>, Vec<String>, Vec<String>)> = targets
        .par_iter()
        .map(|&width| {
            let height = ((u64::from(source_height) * u64::from(width)
                + u64::from(source_width) / 2)
                / u64::from(source_width))
            .max(1) as u32;

            let pixels = match resize(&flat, width, height) {
                Ok(pixels) => pixels,
                Err(err) => {
                    return (
                        Vec::new(),
                        vec![format!(
                            "{}: could not resize to {width}px: {err}",
                            naming.stem
                        )],
                        Vec::new(),
                    )
                }
            };

            let shared = Shared {
                exif: &exif,
                role: naming.role,
                peak_name: &peak.name,
                source_width,
                source_ratio,
            };
            let write = |extension: &str| {
                write_one(
                    Target {
                        out_path: work_dir.join(format!("{}-{}.{}", naming.stem, width, extension)),
                        extension,
                        pixels: &pixels,
                        width,
                        height,
                    },
                    &shared,
                )
            };

            // WebP is required and its absence is a real failure; AVIF is a
            // bonus, and a build that cannot write one still publishes.
            let (webp, avif) = rayon::join(|| write("webp"), || write("avif"));

            let mut written = Vec::new();
            let mut failures = Vec::new();
            let mut skipped = Vec::new();

            match webp {
                Ok(one) => written.push(one),
                Err(err) => failures.push(format!(
                    "{}: could not write WebP at {width}px: {err}",
                    naming.stem
                )),
            }
            match avif {
                Ok(one) => written.push(one),
                Err(_) => skipped.push("avif".to_string()),
            }
            (written, failures, skipped)
        })
        .collect();

    let mut outcome = Outcome::default();
    for (written, failures, skipped) in results {
        for one in written {
            outcome.failures.extend(one.failures);
            outcome.entries.push(one.entry);
        }
        outcome.failures.extend(failures);
        outcome.skipped_formats.extend(skipped);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    fn transparency_composites_onto_white_rather_than_black() {
        let mut source = RgbaImage::new(4, 4);
        source.put_pixel(0, 0, Rgba([0, 0, 0, 0]));
        let flat = flatten(&DynamicImage::ImageRgba8(source));

        // Converting straight to RGB would keep the black underneath.
        assert_eq!(flat.get_pixel(0, 0), &Rgb([255, 255, 255]));
    }

    #[test]
    fn a_half_transparent_red_lands_halfway_to_white() {
        let mut source = RgbaImage::new(1, 1);
        source.put_pixel(0, 0, Rgba([255, 0, 0, 128]));
        let flat = flatten(&DynamicImage::ImageRgba8(source));

        let pixel = flat.get_pixel(0, 0);
        assert_eq!(pixel[0], 255);
        assert!((126..=129).contains(&pixel[1]), "got {pixel:?}");
    }

    #[test]
    fn an_opaque_picture_is_left_alone() {
        let source = RgbImage::from_pixel(2, 2, Rgb([10, 20, 30]));
        let flat = flatten(&DynamicImage::ImageRgb8(source));
        assert_eq!(flat.get_pixel(1, 1), &Rgb([10, 20, 30]));
    }

    #[test]
    fn orientation_six_turns_a_landscape_into_a_portrait() {
        let source = DynamicImage::ImageRgb8(RgbImage::new(40, 20));
        let turned = upright(source, 6);
        assert_eq!((turned.width(), turned.height()), (20, 40));
    }

    #[test]
    fn orientation_one_changes_nothing() {
        let source = DynamicImage::ImageRgb8(RgbImage::new(40, 20));
        assert_eq!((upright(source, 1).width(), 20), (40, 20));
    }

    #[test]
    fn resizing_keeps_the_pixel_count_the_target_asks_for() {
        let source = RgbImage::from_pixel(100, 50, Rgb([1, 2, 3]));
        let pixels = resize(&source, 20, 10).unwrap();
        assert_eq!(pixels.len(), 20 * 10 * 3);
    }
}
