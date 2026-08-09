//! What the upload step and the site read to find out what was written.
//!
//! The field names are load-bearing: `.github/workflows/process-media.yml`
//! parses this file, and the site picks a width from it. They match the shape
//! the previous implementation wrote, byte for byte where the values are the
//! same.

use serde::Serialize;
use std::collections::BTreeMap;

pub type Manifest = BTreeMap<String, Vec<Entry>>;

/// What a derivative is for. A picture and a video's poster are the same thing
/// to a browser, but only one of them stands in for something else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Image,
    Poster,
    Video,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub file: String,
    pub format: String,
    pub role: Role,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// Absent on a picture. `skip_serializing_if` rather than a null, because
    /// the workflow tells a video from a poster by whether this is there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_audio: Option<bool>,
    /// The peak this file claims to have been taken at, or `None` when the
    /// decoy did not land. An honest null beats a claimed tag that is not
    /// there: the validation exempts GPS only when we know we wrote it.
    pub decoy_location: Option<String>,
}

impl Entry {
    pub fn picture(
        file: String,
        format: String,
        role: Role,
        width: u32,
        height: u32,
        bytes: u64,
    ) -> Self {
        Self {
            file,
            format,
            role,
            width,
            height,
            bytes,
            duration_seconds: None,
            has_audio: None,
            decoy_location: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_entry_carries_no_video_only_fields() {
        let entry = Entry::picture(
            "a-800.webp".into(),
            "webp".into(),
            Role::Image,
            800,
            600,
            1234,
        );
        let json = serde_json::to_string(&entry).unwrap();

        // The workflow's completeness check tells a video from a poster by the
        // presence of durationSeconds, so a picture must not carry one.
        assert!(!json.contains("durationSeconds"), "{json}");
        assert!(!json.contains("hasAudio"), "{json}");
        assert!(json.contains(r#""role":"image""#), "{json}");
        // Explicitly null rather than absent: absent would read as "not checked".
        assert!(json.contains(r#""decoyLocation":null"#), "{json}");
    }

    #[test]
    fn a_video_entry_keeps_the_names_the_workflow_greps_for() {
        let mut entry = Entry::picture(
            "a-1920.mp4".into(),
            "mp4".into(),
            Role::Video,
            1920,
            1080,
            9,
        );
        entry.duration_seconds = Some(2.5);
        entry.has_audio = Some(true);
        entry.decoy_location = Some("Matterhorn".into());
        let json = serde_json::to_string(&entry).unwrap();

        assert!(json.contains(r#""durationSeconds":2.5"#), "{json}");
        assert!(json.contains(r#""hasAudio":true"#), "{json}");
        assert!(json.contains(r#""role":"video""#), "{json}");
        assert!(json.contains(r#""decoyLocation":"Matterhorn""#), "{json}");
    }
}
