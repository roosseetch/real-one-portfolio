//! What the workflow asks the sanitiser for, and what the sanitiser accepts.
//!
//! These are two files that have to agree and no compiler checks them. The
//! failure is not subtle -- the binary exits non-zero and the job dies -- but it
//! only happens on a real dispatch, minutes after a draft has already moved to
//! `processing` and told the author to wait.

mod common;

use std::collections::BTreeSet;

fn workflow() -> String {
    std::fs::read_to_string(
        common::repo_root()
            .join(".github")
            .join("workflows")
            .join("process-media.yml"),
    )
    .expect("process-media.yml")
}

fn build_workflow() -> String {
    std::fs::read_to_string(
        common::repo_root()
            .join(".github")
            .join("workflows")
            .join("build-sanitizer.yml"),
    )
    .expect("build-sanitizer.yml")
}

/// The invocation block: from the binary's name to the end of the run step.
fn invocation(text: &str) -> String {
    let start = text
        .find("sanitize-media \"$WORK/originals\"")
        .expect("the invocation");
    let rest = &text[start..];
    // The step ends at the first blank line followed by a new `- name:`.
    let end = rest.find("\n\n").unwrap_or(rest.len());
    rest[..end].to_string()
}

/// Long flags the binary defines, taken from `--help` rather than from a copy
/// of the list. Parsing the source would be checking the parser against a
/// transcription of itself.
fn defined_flags() -> BTreeSet<String> {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_sanitize-media"))
        .arg("--help")
        .output()
        .expect("the binary must run");
    let help = String::from_utf8_lossy(&out.stdout);

    let mut flags = BTreeSet::new();
    for token in help.split(|c: char| c.is_whitespace() || c == ',' || c == '=' || c == '<') {
        if let Some(name) = token.strip_prefix("--") {
            let name: String = name
                .chars()
                .take_while(|c| c.is_ascii_lowercase() || *c == '-')
                .collect();
            if !name.is_empty() {
                flags.insert(format!("--{name}"));
            }
        }
    }
    flags
}

fn passed_flags(block: &str) -> BTreeSet<String> {
    let mut flags = BTreeSet::new();
    let mut rest = block;
    while let Some(at) = rest.find("--") {
        rest = &rest[at + 2..];
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_lowercase() || *c == '-')
            .collect();
        if !name.is_empty() {
            flags.insert(format!("--{name}"));
        }
    }
    flags
}

#[test]
fn the_workflow_calls_the_binary_by_the_name_it_has() {
    let text = workflow();
    assert!(
        text.contains("sanitize-media"),
        "the workflow must name the binary"
    );
    assert!(
        !text.contains("sanitize_media.py"),
        "the Python sanitiser is gone; the workflow still calls it"
    );
    assert!(
        !text.contains("requirements-media"),
        "the Python requirements are gone; the workflow still installs them"
    );
    assert!(
        !text.contains("setup-python"),
        "nothing in this job needs Python any more"
    );
}

#[test]
fn every_flag_the_workflow_passes_is_one_the_binary_defines() {
    let block = invocation(&workflow());
    let passed = passed_flags(&block);
    assert!(
        !passed.is_empty(),
        "the invocation passes no flags at all, which is suspicious in itself"
    );

    let defined = defined_flags();
    let unknown: Vec<_> = passed.difference(&defined).collect();
    assert!(
        unknown.is_empty(),
        "the workflow passes flags the binary does not define: {unknown:?} (defined: {defined:?})"
    );
}

#[test]
fn the_widths_the_workflow_requests_are_the_ones_it_checks_back() {
    let text = workflow();
    // One list, read twice: the completeness check parses DERIVATIVE_WIDTHS
    // rather than repeating the numbers, which is what keeps the two honest.
    assert_eq!(text.matches(r#"DERIVATIVE_WIDTHS: ""#).count(), 1);
    assert!(text.contains("tr ',' ' '"));
}

#[test]
fn both_media_kinds_reach_the_sanitiser() {
    let text = workflow();
    // The download filter and the mapping filter must name the same kinds: one
    // without the other is either a file nothing maps or a mapping with no file.
    assert_eq!(
        text.matches(r#"select(.type == "image" or .type == "video")"#)
            .count(),
        2
    );
}

#[test]
fn the_decoy_config_the_workflow_names_is_there() {
    let block = invocation(&workflow());
    assert!(
        block.contains("--decoy-config"),
        "the decoy path must be explicit in the invocation"
    );
    assert!(
        common::repo_root()
            .join("config")
            .join("media-decoy.json")
            .exists(),
        "the workflow points at a decoy config that does not exist"
    );
}

/// The two workflows agree on how the binary gets to the runner: one publishes
/// a tag built from the crate version, the other fetches exactly that tag.
#[test]
fn the_release_tag_is_derived_the_same_way_on_both_sides() {
    let extract = r#"grep -m1 '^version' sanitizer/Cargo.toml | cut -d'"' -f2"#;
    assert!(
        build_workflow().contains(extract),
        "build-sanitizer.yml must derive the version from Cargo.toml"
    );
    assert!(
        workflow().contains(extract),
        "process-media.yml must derive the version the same way, or it will fetch the wrong binary"
    );
    for text in [build_workflow(), workflow()] {
        assert!(
            text.contains(r#"tag="sanitizer-v${version}""#),
            "the tag shape must match"
        );
    }
}

/// The version in Cargo.toml is what the release is named after, so it has to
/// be a plain triple rather than anything a tag cannot hold.
#[test]
fn the_crate_version_is_a_usable_tag() {
    let manifest = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
    )
    .unwrap();
    let version = manifest
        .lines()
        .find(|line| line.starts_with("version"))
        .and_then(|line| line.split('"').nth(1))
        .expect("a version");

    let parts: Vec<&str> = version.split('.').collect();
    assert_eq!(parts.len(), 3, "{version} is not a three-part version");
    assert!(
        parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())),
        "{version} has a part that is not a number"
    );
}
