//! Builds a TIFF/EXIF block, and puts one inside a WebP.
//!
//! This is the half of the old exiftool dependency that had to be written out
//! rather than handed to ffmpeg. It is deliberately small and deliberately the
//! only place that decides what the decoy bytes are: the same block goes into
//! the AVIF (through rav1e, which takes it as-is) and into the WebP (spliced in
//! below), so the two formats cannot drift into disagreeing about a file.
//!
//! Writing EXIF is only ever *additive* here. Removal has already happened, by
//! re-encoding from decoded pixels -- nothing carried from the source survives
//! into a buffer this module ever sees.

use crate::decoy::{deg_to_dms, lat_ref, lon_ref, Decoy, Peak};
use anyhow::{bail, Result};

// TIFF field types, of which we need three.
const ASCII: u16 = 2;
const RATIONAL: u16 = 5;
const BYTE: u16 = 1;

// IFD0
const TAG_MAKE: u16 = 0x010F;
const TAG_MODEL: u16 = 0x0110;
const TAG_SOFTWARE: u16 = 0x0131;
const TAG_ARTIST: u16 = 0x013B;
const TAG_HOST_COMPUTER: u16 = 0x013C;
const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;

// Exif IFD
const TAG_DATE_TIME_ORIGINAL: u16 = 0x9003;
const TAG_BODY_SERIAL_NUMBER: u16 = 0xA431;

// GPS IFD
const TAG_GPS_VERSION_ID: u16 = 0x0000;
const TAG_GPS_LATITUDE_REF: u16 = 0x0001;
const TAG_GPS_LATITUDE: u16 = 0x0002;
const TAG_GPS_LONGITUDE_REF: u16 = 0x0003;
const TAG_GPS_LONGITUDE: u16 = 0x0004;

#[derive(Debug, Clone)]
struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    /// Serialized value. Four bytes or fewer live in the entry itself; anything
    /// longer is written to the data area and the entry holds its offset.
    value: Vec<u8>,
}

fn ascii(tag: u16, text: &str) -> Entry {
    let mut value = text.as_bytes().to_vec();
    value.push(0); // NUL-terminated, per the TIFF spec for ASCII.
    Entry {
        tag,
        kind: ASCII,
        count: value.len() as u32,
        value,
    }
}

fn rationals(tag: u16, values: &[(u32, u32)]) -> Entry {
    let mut value = Vec::with_capacity(values.len() * 8);
    for (numerator, denominator) in values {
        value.extend_from_slice(&numerator.to_be_bytes());
        value.extend_from_slice(&denominator.to_be_bytes());
    }
    Entry {
        tag,
        kind: RATIONAL,
        count: values.len() as u32,
        value,
    }
}

fn bytes(tag: u16, values: &[u8]) -> Entry {
    Entry {
        tag,
        kind: BYTE,
        count: values.len() as u32,
        value: values.to_vec(),
    }
}

/// A pointer to another IFD, patched once the layout is known.
fn pointer(tag: u16) -> Entry {
    Entry {
        tag,
        kind: 4, /* LONG */
        count: 1,
        value: vec![0, 0, 0, 0],
    }
}

/// The three IFDs an EXIF block is made of, in the order they get written.
#[derive(Debug, Default, Clone)]
pub struct ExifBlock {
    ifd0: Vec<Entry>,
    exif: Vec<Entry>,
    gps: Vec<Entry>,
}

impl ExifBlock {
    /// Everything the decoy claims about a picture.
    pub fn decoy(decoy: &Decoy, peak: &Peak, taken_at: &str) -> Self {
        let mut block = Self::default();
        block.ifd0.push(ascii(TAG_MAKE, &decoy.camera.make));
        block.ifd0.push(ascii(TAG_MODEL, &decoy.camera.model));
        block.exif.push(ascii(TAG_DATE_TIME_ORIGINAL, taken_at));

        // 2.3.0.0 is the GPS tag version every reader expects to find first.
        block.gps.push(bytes(TAG_GPS_VERSION_ID, &[2, 3, 0, 0]));
        block
            .gps
            .push(ascii(TAG_GPS_LATITUDE_REF, lat_ref(peak.lat)));
        block
            .gps
            .push(rationals(TAG_GPS_LATITUDE, &deg_to_dms(peak.lat)));
        block
            .gps
            .push(ascii(TAG_GPS_LONGITUDE_REF, lon_ref(peak.lon)));
        block
            .gps
            .push(rationals(TAG_GPS_LONGITUDE, &deg_to_dms(peak.lon)));
        block
    }

    /// The tags a real camera writes, for a fixture that has to start dirty.
    ///
    /// Lives here rather than in the tests so that both the thing that writes a
    /// forbidden tag and the thing that must strip it agree on what one is.
    pub fn dirty_fixture() -> Self {
        let mut block = Self::default();
        block.ifd0.push(ascii(TAG_MAKE, "Canon"));
        block.ifd0.push(ascii(TAG_MODEL, "EOS R6"));
        block.ifd0.push(ascii(TAG_SOFTWARE, "Darktable 4.6"));
        block.ifd0.push(ascii(TAG_ARTIST, "A Real Photographer"));
        block
            .ifd0
            .push(ascii(TAG_HOST_COMPUTER, "a-real-laptop.local"));
        block
            .exif
            .push(ascii(TAG_DATE_TIME_ORIGINAL, "2026:04:11 08:14:22"));
        block.exif.push(ascii(TAG_BODY_SERIAL_NUMBER, "0123456789"));
        // Amsterdam, 52.37N 4.90E -- the coordinates the tests look for.
        block.gps.push(bytes(TAG_GPS_VERSION_ID, &[2, 3, 0, 0]));
        block.gps.push(ascii(TAG_GPS_LATITUDE_REF, "N"));
        block
            .gps
            .push(rationals(TAG_GPS_LATITUDE, &deg_to_dms(52.3676)));
        block.gps.push(ascii(TAG_GPS_LONGITUDE_REF, "E"));
        block
            .gps
            .push(rationals(TAG_GPS_LONGITUDE, &deg_to_dms(4.9041)));
        block
    }

    /// Serializes to a standalone TIFF block, big-endian.
    ///
    /// This is the form both a WebP `EXIF` chunk and an AVIF Exif item want:
    /// the bare TIFF header onwards, with no `Exif\0\0` prefix.
    pub fn to_tiff(&self) -> Vec<u8> {
        // Header is 8 bytes, then the IFDs back to back, then one shared data
        // area for every value too long to sit inside its entry.
        let ifd0_at = 8u32;
        let ifd0_size = ifd_size(
            self.ifd0.len()
                + usize::from(!self.exif.is_empty())
                + usize::from(!self.gps.is_empty()),
        );
        let exif_at = ifd0_at + ifd0_size;
        let exif_size = if self.exif.is_empty() {
            0
        } else {
            ifd_size(self.exif.len())
        };
        let gps_at = exif_at + exif_size;
        let gps_size = if self.gps.is_empty() {
            0
        } else {
            ifd_size(self.gps.len())
        };
        let mut data_at = gps_at + gps_size;

        // IFD0 carries the pointers to the other two, so it is assembled with
        // them appended in the order the tag numbers demand (0x8769 < 0x8825).
        let mut ifd0 = self.ifd0.clone();
        if !self.exif.is_empty() {
            let mut entry = pointer(TAG_EXIF_IFD);
            entry.value = exif_at.to_be_bytes().to_vec();
            ifd0.push(entry);
        }
        if !self.gps.is_empty() {
            let mut entry = pointer(TAG_GPS_IFD);
            entry.value = gps_at.to_be_bytes().to_vec();
            ifd0.push(entry);
        }

        let mut out = Vec::new();
        out.extend_from_slice(b"MM"); // big-endian
        out.extend_from_slice(&0x002Au16.to_be_bytes());
        out.extend_from_slice(&ifd0_at.to_be_bytes());

        let mut data = Vec::new();
        write_ifd(&mut out, &mut data, &mut data_at, &ifd0);
        if !self.exif.is_empty() {
            write_ifd(&mut out, &mut data, &mut data_at, &self.exif);
        }
        if !self.gps.is_empty() {
            write_ifd(&mut out, &mut data, &mut data_at, &self.gps);
        }
        out.extend_from_slice(&data);
        out
    }
}

fn ifd_size(entries: usize) -> u32 {
    // count, then twelve bytes each, then the offset of the next IFD.
    2 + (entries as u32 * 12) + 4
}

/// Writes one IFD, pushing any oversized values onto the shared data area.
///
/// Entries must be in ascending tag order; a reader is entitled to binary
/// search them and several do.
fn write_ifd(out: &mut Vec<u8>, data: &mut Vec<u8>, data_at: &mut u32, entries: &[Entry]) {
    let mut entries = entries.to_vec();
    entries.sort_by_key(|e| e.tag);

    out.extend_from_slice(&(entries.len() as u16).to_be_bytes());
    for entry in &entries {
        out.extend_from_slice(&entry.tag.to_be_bytes());
        out.extend_from_slice(&entry.kind.to_be_bytes());
        out.extend_from_slice(&entry.count.to_be_bytes());
        if entry.value.len() <= 4 {
            // Left-justified in the four value bytes, not right.
            let mut inline = entry.value.clone();
            inline.resize(4, 0);
            out.extend_from_slice(&inline);
        } else {
            out.extend_from_slice(&data_at.to_be_bytes());
            data.extend_from_slice(&entry.value);
            *data_at += entry.value.len() as u32;
            // Values are word-aligned; an odd-length ASCII string would
            // otherwise leave every following offset one byte out.
            if entry.value.len() % 2 == 1 {
                data.push(0);
                *data_at += 1;
            }
        }
    }
    out.extend_from_slice(&0u32.to_be_bytes()); // no next IFD
}

/// Puts an EXIF block into a JPEG, as the APP1 segment right after the SOI.
///
/// Only the tests need this -- it is how a fixture is made dirty enough to be
/// worth stripping. It lives here beside the writer rather than in the test
/// tree so that the thing which plants a forbidden tag and the thing which must
/// remove one cannot disagree about how a tag is stored.
pub fn jpeg_with_exif(jpeg: &[u8], exif: &[u8]) -> Result<Vec<u8>> {
    if jpeg.len() < 2 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        bail!("not a JPEG file");
    }

    // A JPEG APP1 carries the `Exif\0\0` prefix that the other two containers
    // do not, and its length field counts itself.
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(exif);
    let length = payload.len() + 2;
    if length > 0xFFFF {
        bail!("an EXIF block that large needs more than one APP1 segment");
    }

    let mut out = Vec::with_capacity(jpeg.len() + length + 2);
    out.extend_from_slice(&jpeg[0..2]); // SOI
    out.extend_from_slice(&[0xFF, 0xE1]); // APP1
    out.extend_from_slice(&(length as u16).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    Ok(out)
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const WEBP_FLAG_ALPHA: u8 = 0x10;
const WEBP_FLAG_EXIF: u8 = 0x08;

/// Rewrites a simple-format WebP into the extended format, carrying EXIF.
///
/// libwebp emits `RIFF....WEBP` followed by a bare `VP8 ` or `VP8L` chunk,
/// which has nowhere to put metadata. The extended format adds a `VP8X` header
/// declaring what else is present, and permits `EXIF` after the image data.
///
/// Chosen over a library because a RIFF file is a flat list of length-prefixed
/// chunks with no internal offsets -- splicing one in cannot invalidate
/// anything else in the file. That is emphatically not true of the ISOBMFF
/// containers, which is why the AVIF and the MP4 are left to encoders that
/// already know how.
pub fn webp_with_exif(webp: &[u8], exif: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    if webp.len() < 12 || &webp[0..4] != b"RIFF" || &webp[8..12] != b"WEBP" {
        bail!("not a WebP file");
    }
    if width == 0 || height == 0 || width > 1 << 24 || height > 1 << 24 {
        bail!(
            "canvas {}x{} is outside what a VP8X header can describe",
            width,
            height
        );
    }

    let mut existing: Vec<u8> = Vec::new();
    let mut has_alpha = false;
    let mut offset = 12;
    while offset + 8 <= webp.len() {
        let fourcc = &webp[offset..offset + 4];
        let size = u32::from_le_bytes(webp[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let padded = size + (size % 2);
        let end = offset + 8 + padded;
        if end > webp.len() {
            bail!("truncated {} chunk", String::from_utf8_lossy(fourcc));
        }
        // An encoder we did not ask for already produced an extended file.
        // Rather than merge headers, refuse: a wrong VP8X flag byte is a file
        // some decoders reject outright.
        if fourcc == b"VP8X" {
            bail!("the WebP is already in extended format");
        }
        // Anything but the image data itself is dropped. libwebp writes none of
        // it for our inputs, and carrying an unexamined chunk across would be
        // the one way source metadata could survive this path.
        if fourcc == b"VP8 " || fourcc == b"VP8L" || fourcc == b"ALPH" {
            // The VP8X flag byte has to agree with the chunks that follow it. A
            // carried ALPH with the alpha bit clear is a file some decoders
            // reject and others render without transparency. Nothing here
            // produces one today -- the pixels are flattened to RGB long before
            // this -- but a header that contradicts its own body is not a thing
            // to leave lying around in a container writer.
            has_alpha |= fourcc == b"ALPH";
            existing.extend_from_slice(&webp[offset..end]);
        }
        offset = end;
    }
    if existing.is_empty() {
        bail!("the WebP carries no image data");
    }

    let mut body = Vec::with_capacity(webp.len() + exif.len() + 32);
    body.extend_from_slice(b"WEBP");

    // VP8X: one flag byte, three reserved, then canvas dimensions minus one as
    // 24-bit little-endian.
    body.extend_from_slice(b"VP8X");
    body.extend_from_slice(&10u32.to_le_bytes());
    body.push(WEBP_FLAG_EXIF | if has_alpha { WEBP_FLAG_ALPHA } else { 0 });
    body.extend_from_slice(&[0, 0, 0]);
    body.extend_from_slice(&(width - 1).to_le_bytes()[0..3]);
    body.extend_from_slice(&(height - 1).to_le_bytes()[0..3]);

    body.extend_from_slice(&existing);

    body.extend_from_slice(b"EXIF");
    body.extend_from_slice(&(exif.len() as u32).to_le_bytes());
    body.extend_from_slice(exif);
    if exif.len() % 2 == 1 {
        body.push(0);
    }

    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decoy::Peak;

    fn sample_block() -> ExifBlock {
        let decoy: Decoy = serde_json::from_str(
            r#"{"camera":{"make":"Sony","model":"Alpha"},
                "dateTimeOriginal":{"date":"2117:03:03","randomizeTime":false},
                "gpsCandidates":[{"name":"Matterhorn","lat":45.9763,"lon":7.6586}]}"#,
        )
        .unwrap();
        let peak = Peak {
            name: "Matterhorn".into(),
            lat: 45.9763,
            lon: 7.6586,
        };
        ExifBlock::decoy(&decoy, &peak, "2117:03:03 12:00:00")
    }

    #[test]
    fn the_tiff_block_starts_with_a_big_endian_header() {
        let tiff = sample_block().to_tiff();
        assert_eq!(&tiff[0..2], b"MM");
        assert_eq!(u16::from_be_bytes([tiff[2], tiff[3]]), 0x002A);
        assert_eq!(u32::from_be_bytes([tiff[4], tiff[5], tiff[6], tiff[7]]), 8);
    }

    /// The raw ASCII behind a tag. `display_value` wraps a string in quotes and
    /// reformats a date, neither of which is what was written to the file.
    fn ascii_of(parsed: &exif::Exif, tag: exif::Tag) -> Option<String> {
        match &parsed.get_field(tag, exif::In::PRIMARY)?.value {
            exif::Value::Ascii(parts) => parts
                .first()
                .map(|bytes| String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }

    /// The block has to survive a reader that is not ours. kamadak-exif is an
    /// independent parser, and the integration tests additionally check the
    /// written files against exiftool.
    #[test]
    fn an_independent_parser_reads_back_what_was_written() {
        let tiff = sample_block().to_tiff();
        let parsed = exif::Reader::new()
            .read_raw(tiff)
            .expect("our own EXIF must parse");

        assert_eq!(ascii_of(&parsed, exif::Tag::Make).as_deref(), Some("Sony"));
        assert_eq!(
            ascii_of(&parsed, exif::Tag::Model).as_deref(),
            Some("Alpha")
        );
        assert_eq!(
            ascii_of(&parsed, exif::Tag::DateTimeOriginal).as_deref(),
            Some("2117:03:03 12:00:00")
        );
        assert_eq!(
            ascii_of(&parsed, exif::Tag::GPSLatitudeRef).as_deref(),
            Some("N")
        );

        // The coordinate is three rationals, and the degrees are enough to tell
        // one Alpine peak from another.
        let latitude = parsed
            .get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
            .expect("a latitude")
            .display_value()
            .to_string();
        assert!(
            latitude.starts_with("45"),
            "latitude read back as {latitude}"
        );
    }

    #[test]
    fn the_dirty_fixture_really_is_dirty() {
        let tiff = ExifBlock::dirty_fixture().to_tiff();
        let parsed = exif::Reader::new().read_raw(tiff).unwrap();
        for tag in [
            exif::Tag::Make,
            exif::Tag::Software,
            exif::Tag::Artist,
            exif::Tag::BodySerialNumber,
        ] {
            assert!(
                parsed.get_field(tag, exif::In::PRIMARY).is_some(),
                "a fixture missing {tag:?} would let a strip test pass on a file that was never dirty"
            );
        }
    }

    #[test]
    fn webp_gains_a_vp8x_header_and_an_exif_chunk() {
        // A minimal simple-format WebP: header plus one VP8 chunk.
        let mut simple = b"RIFF".to_vec();
        let payload = b"VP8 \x04\x00\x00\x00abcd";
        simple.extend_from_slice(&((4 + payload.len()) as u32).to_le_bytes());
        simple.extend_from_slice(b"WEBP");
        simple.extend_from_slice(payload);

        let out = webp_with_exif(&simple, b"EXIFBYTES", 800, 600).unwrap();

        assert_eq!(&out[0..4], b"RIFF");
        assert_eq!(&out[8..12], b"WEBP");
        assert_eq!(&out[12..16], b"VP8X");
        assert_eq!(
            out[20] & WEBP_FLAG_EXIF,
            WEBP_FLAG_EXIF,
            "the EXIF flag must be set"
        );
        // Canvas dimensions are stored minus one.
        assert_eq!(u32::from_le_bytes([out[24], out[25], out[26], 0]), 799);
        assert_eq!(u32::from_le_bytes([out[27], out[28], out[29], 0]), 599);
        assert!(out.windows(4).any(|w| w == b"EXIF"));
        assert!(out.windows(9).any(|w| w == b"EXIFBYTES"));
        // The declared RIFF size must match what was actually written.
        assert_eq!(
            u32::from_le_bytes(out[4..8].try_into().unwrap()) as usize,
            out.len() - 8
        );
    }

    #[test]
    fn an_odd_length_exif_payload_is_padded_to_an_even_boundary() {
        let mut simple = b"RIFF".to_vec();
        let payload = b"VP8 \x04\x00\x00\x00abcd";
        simple.extend_from_slice(&((4 + payload.len()) as u32).to_le_bytes());
        simple.extend_from_slice(b"WEBP");
        simple.extend_from_slice(payload);

        let out = webp_with_exif(&simple, b"odd", 8, 8).unwrap();
        assert_eq!(
            out.len() % 2,
            0,
            "a RIFF chunk must end on an even boundary"
        );
    }

    #[test]
    fn a_carried_alpha_chunk_sets_the_flag_that_declares_it() {
        let mut simple = b"RIFF".to_vec();
        let mut payload = b"ALPH\x02\x00\x00\x00ab".to_vec();
        payload.extend_from_slice(b"VP8 \x04\x00\x00\x00abcd");
        simple.extend_from_slice(&((4 + payload.len()) as u32).to_le_bytes());
        simple.extend_from_slice(b"WEBP");
        simple.extend_from_slice(&payload);

        let out = webp_with_exif(&simple, b"EXIFBYTES", 8, 8).unwrap();

        // A header that says "no alpha" over a body that carries one is a file
        // some decoders reject and others render opaque.
        assert_eq!(out[20] & WEBP_FLAG_ALPHA, WEBP_FLAG_ALPHA);
        assert_eq!(out[20] & WEBP_FLAG_EXIF, WEBP_FLAG_EXIF);
    }

    #[test]
    fn an_opaque_webp_does_not_claim_an_alpha_channel() {
        let mut simple = b"RIFF".to_vec();
        let payload = b"VP8 \x04\x00\x00\x00abcd";
        simple.extend_from_slice(&((4 + payload.len()) as u32).to_le_bytes());
        simple.extend_from_slice(b"WEBP");
        simple.extend_from_slice(payload);

        let out = webp_with_exif(&simple, b"EXIFBYTES", 8, 8).unwrap();
        assert_eq!(out[20] & WEBP_FLAG_ALPHA, 0);
    }

    #[test]
    fn a_file_that_is_not_a_webp_is_refused() {
        assert!(webp_with_exif(b"not a webp at all", b"x", 8, 8).is_err());
    }
}
