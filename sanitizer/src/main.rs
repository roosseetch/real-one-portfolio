//! Sanitises source photos and videos into public web derivatives.
//!
//!     sanitize-media <source-dir> <work-dir> <mapping.json> [--widths 1600,800]
//!
//! mapping.json maps output ids to a source file and its kind, for example
//!     {"hero": {"file": "main_foto.jpeg", "type": "image"},
//!      "clip": {"file": "morning_run.mov", "type": "video"}}

use anyhow::{bail, Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::process::ExitCode;

use sanitize_media::{decoy::Decoy, sanitize, Options};

#[derive(Parser, Debug)]
#[command(about = "Strip every trace of the original metadata and inject the configured decoy")]
struct Args {
    /// Where the originals are. Never written to.
    source_dir: PathBuf,
    /// Where the derivatives and manifest.json are written.
    work_dir: PathBuf,
    /// JSON mapping output ids to a source file and its kind.
    mapping: PathBuf,

    #[arg(long, default_value = "1600,1200,800,320")]
    widths: String,
    #[arg(long, default_value_t = 20)]
    video_crf: u32,
    #[arg(long, default_value = "medium")]
    video_preset: String,
    #[arg(long, default_value_t = 1920)]
    video_max_width: u32,
    /// The decoy values to inject. Relative paths resolve against the working
    /// directory, which is the repository root when the workflow runs this.
    #[arg(long, default_value = "config/media-decoy.json")]
    decoy_config: PathBuf,
}

/// Whichever of the tools this run needs are not on the machine.
///
/// exiftool is deliberately absent: this program writes its own EXIF, and the
/// only thing that still shells out to a tag editor is the workflow's own
/// independent verification step.
fn missing_tools(needs_video: bool) -> Vec<&'static str> {
    let needed: &[&str] = if needs_video {
        &["ffmpeg", "ffprobe"]
    } else {
        &[]
    };
    needed
        .iter()
        .copied()
        .filter(|tool| which(tool).is_none())
        .collect()
}

fn which(tool: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(tool))
            .find(|candidate| candidate.is_file())
    })
}

fn parse_widths(raw: &str) -> Result<Vec<u32>> {
    let widths: Result<Vec<u32>> = raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.parse::<u32>()
                .with_context(|| format!("{part:?} is not a width"))
        })
        .collect();
    let widths = widths?;
    if widths.is_empty() {
        bail!("no widths were requested");
    }
    Ok(widths)
}

fn run(args: &Args) -> Result<bool> {
    let raw = std::fs::read_to_string(&args.mapping)
        .with_context(|| format!("could not read the mapping at {}", args.mapping.display()))?;
    let mapping: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&raw).context("the mapping is not a JSON object")?;

    let needs_video = mapping
        .values()
        .any(|spec| spec.get("type").and_then(|t| t.as_str()) == Some("video"));
    let absent = missing_tools(needs_video);
    if !absent.is_empty() {
        bail!("Missing on this machine: {}", absent.join(", "));
    }

    let decoy = Decoy::load(&args.decoy_config)?;
    let options = Options {
        widths: parse_widths(&args.widths)?,
        video_crf: args.video_crf,
        video_preset: args.video_preset.clone(),
        video_max_width: args.video_max_width,
    };

    let mut rng = rand::thread_rng();
    let result = sanitize(
        &args.source_dir,
        &args.work_dir,
        &mapping,
        &decoy,
        &options,
        &mut rng,
    )?;

    for entries in result.manifest.values() {
        for entry in entries {
            let decoy_note = match &entry.decoy_location {
                Some(name) => format!("decoy@{name}"),
                None => "no decoy (format)".to_string(),
            };
            let extra = match entry.duration_seconds {
                Some(seconds) => format!(" {seconds}s"),
                None => String::new(),
            };
            let size = format!("{}x{}", entry.width, entry.height);
            println!(
                "{:<36} {:<11} {:>7.1} KiB{}  {}",
                entry.file,
                size,
                entry.bytes as f64 / 1024.0,
                extra,
                decoy_note
            );
        }
    }

    if !result.skipped_formats.is_empty() {
        let skipped: Vec<&str> = result.skipped_formats.iter().map(String::as_str).collect();
        println!(
            "\nSkipped, the encoder would not write one: {}",
            skipped.join(", ")
        );
    }

    if !result.failures.is_empty() {
        eprintln!("\nFAILURES:");
        for failure in &result.failures {
            eprintln!("  {failure}");
        }
        return Ok(false);
    }

    let written: usize = result.manifest.values().map(Vec::len).sum();
    println!(
        "\n{written} derivatives written to {}",
        args.work_dir.display()
    );
    Ok(true)
}

fn main() -> ExitCode {
    let args = Args::parse();
    match run(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(err) => {
            eprintln!("{err:#}");
            ExitCode::FAILURE
        }
    }
}
