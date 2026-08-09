//! The fiction a sanitised file is allowed to tell about itself.
//!
//! Read from `config/media-decoy.json`, which is deliberately not tied to any
//! person: it makes a published photo look ordinary rather than proving
//! anything. This is privacy hardening, not a security boundary.

use anyhow::{Context, Result};
use rand::Rng;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Camera {
    pub make: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub date: String,
    #[serde(default)]
    pub randomize_time: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Peak {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoy {
    pub camera: Camera,
    pub date_time_original: Stamp,
    pub gps_candidates: Vec<Peak>,
}

impl Decoy {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("could not read the decoy config at {}", path.display()))?;
        serde_json::from_str(&text)
            .with_context(|| format!("{} is not a decoy config this understands", path.display()))
    }

    /// One of the configured peaks, drawn at random.
    pub fn peak(&self, rng: &mut impl Rng) -> Peak {
        let index = rng.gen_range(0..self.gps_candidates.len());
        self.gps_candidates[index].clone()
    }

    /// `YYYY:MM:DD HH:MM:SS`, in the one shape an EXIF date tag accepts.
    pub fn taken_at(&self, rng: &mut impl Rng) -> String {
        let stamp = &self.date_time_original;
        let time = if stamp.randomize_time {
            format!(
                "{:02}:{:02}:{:02}",
                rng.gen_range(0..24),
                rng.gen_range(0..60),
                rng.gen_range(0..60)
            )
        } else {
            "12:00:00".to_string()
        };
        format!("{} {}", stamp.date, time)
    }
}

/// Degrees, minutes and seconds, as EXIF stores a coordinate.
///
/// Seconds keep two decimal places, which is a little over 30cm -- far finer
/// than a decoy needs and the same precision the previous implementation wrote.
pub fn deg_to_dms(value: f64) -> [(u32, u32); 3] {
    let value = value.abs();
    let degrees = value.trunc();
    let minutes_full = (value - degrees) * 60.0;
    let minutes = minutes_full.trunc();
    let seconds = (minutes_full - minutes) * 60.0;
    [
        (degrees as u32, 1),
        (minutes as u32, 1),
        ((seconds * 100.0).round() as u32, 100),
    ]
}

/// The one location format an MP4 container understands, per ISO 6709.
///
/// Signed, fixed-width, and closed with a solidus. QuickTime readers that meet
/// an unterminated string treat the whole atom as malformed.
///
/// The widths are one wider than ISO 6709 asks for -- the standard is
/// `±DD.DDDD±DDD.DDDD/` and this writes `±DDD.DDDD±DDDD.DDDD/`. That is
/// deliberate here only in the sense that it is what the previous
/// implementation wrote, and what every video published so far therefore
/// carries; readers take it because they parse digits up to the decimal point
/// rather than counting columns. Narrowing it is a one-character change, but it
/// would make new files disagree with old ones, so it is not being made
/// silently as part of a port.
pub fn iso6709(lat: f64, lon: f64) -> String {
    format!("{:+09.4}{:+010.4}/", lat, lon)
}

/// `N`/`S` and `E`/`W`, which is where the sign lives in EXIF.
pub fn lat_ref(lat: f64) -> &'static str {
    if lat >= 0.0 {
        "N"
    } else {
        "S"
    }
}

pub fn lon_ref(lon: f64) -> &'static str {
    if lon >= 0.0 {
        "E"
    } else {
        "W"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso6709_is_fixed_width_signed_and_terminated() {
        // The exact string the previous implementation produced, which is what
        // a QuickTime reader will accept.
        // Byte for byte what the Python implementation produced -- including
        // the extra leading zero in each half, which the doc comment on
        // `iso6709` explains is kept on purpose.
        assert_eq!(iso6709(45.9763, 7.6586), "+045.9763+0007.6586/");
        assert_eq!(iso6709(-33.8688, 151.2093), "-033.8688+0151.2093/");
        assert_eq!(iso6709(0.0, 0.0), "+000.0000+0000.0000/");
        // The parts a reader actually needs: a sign on each half, a fixed
        // number of decimals, and the closing solidus.
        let written = iso6709(-45.9763, -7.6586);
        assert!(written.starts_with('-') && written.ends_with('/'));
        assert_eq!(written.matches('.').count(), 2);
    }

    #[test]
    fn dms_splits_a_degree_the_way_exif_expects() {
        // 45.9763 deg -> 45 deg 58' 34.68"
        let dms = deg_to_dms(45.9763);
        assert_eq!(dms[0], (45, 1));
        assert_eq!(dms[1], (58, 1));
        assert_eq!(dms[2], (3468, 100));
    }

    #[test]
    fn dms_drops_the_sign_because_the_hemisphere_ref_carries_it() {
        assert_eq!(deg_to_dms(-45.9763)[0], (45, 1));
        assert_eq!(lat_ref(-45.9763), "S");
        assert_eq!(lon_ref(-7.6586), "W");
    }
}
