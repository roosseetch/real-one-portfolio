//! Puts a directory of sanitised derivatives into the public media bucket.
//!
//! Two callers, one binary. The media workflow uploads an activity's
//! derivatives with the write-only S3 key it holds for that bucket; a person
//! publishing a profile photograph uploads with a Cloudflare API token. What
//! differs between them is the prefix and how long the objects may be cached,
//! and both are arguments.
//!
//! Deliberately in the sanitiser's crate rather than beside it. The check that
//! refuses a file still carrying identifying metadata is the same reader the
//! sanitiser verifies its own output with, and one definition of what counts as
//! identifying is the whole point -- the Python this replaces had its own
//! shorter list, and had been missing Copyright, ImageDescription and
//! HostComputer for as long as it existed.
//!
//!   upload-media <dir> --bucket <name> --prefix media/activity-<id>
//!   upload-media <dir> --bucket <name> --prefix media/profile --cache week

use anyhow::Result;
use clap::{Parser, ValueEnum};
use std::path::PathBuf;
use std::process::ExitCode;

use sanitize_media::upload::{plan, refuse_if_identifying, upload_all, Cache, Credentials};

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CacheArg {
    /// Names carry a media id and a width, so a changed picture is a new name.
    Immutable,
    /// Stable names, so a replacement has to be able to propagate.
    Week,
}

impl From<CacheArg> for Cache {
    fn from(arg: CacheArg) -> Self {
        match arg {
            CacheArg::Immutable => Cache::Immutable,
            CacheArg::Week => Cache::Week,
        }
    }
}

#[derive(Parser, Debug)]
#[command(about = "Upload sanitised derivatives to the public media bucket")]
struct Args {
    /// Directory of derivatives. Read, never written to.
    dir: PathBuf,

    /// Bucket to write into. Never a constant: this repository is meant to be
    /// reused and names no deployment (spec §1).
    #[arg(long)]
    bucket: String,

    /// Key prefix the files are written under, without a trailing slash.
    #[arg(long)]
    prefix: String,

    #[arg(long, value_enum, default_value_t = CacheArg::Immutable)]
    cache: CacheArg,
}

fn run(args: &Args) -> Result<usize> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180))
        .build();

    // Everything that can fail without touching the network happens first. An
    // upload is not undoable by failing a later step -- the object is public
    // the moment it lands -- so the checks belong ahead of the first PUT.
    let uploads = plan(&args.dir, &args.prefix)?;
    if uploads.is_empty() {
        println!("nothing to upload in {}", args.dir.display());
        return Ok(0);
    }
    refuse_if_identifying(&uploads)?;

    let credentials = Credentials::from_env(&agent)?;
    println!(
        "{} objects to {}/{} via {}",
        uploads.len(),
        args.bucket,
        args.prefix.trim_matches('/'),
        credentials.describe()
    );

    upload_all(
        &agent,
        &credentials,
        &args.bucket,
        &uploads,
        args.cache.into(),
    )?;

    for upload in &uploads {
        let bytes = std::fs::metadata(&upload.path)
            .map(|m| m.len())
            .unwrap_or(0);
        println!("  {:<48} {:>7.1} KiB", upload.key, bytes as f64 / 1024.0);
    }
    Ok(uploads.len())
}

fn main() -> ExitCode {
    let args = Args::parse();
    match run(&args) {
        Ok(count) => {
            println!(
                "\n{count} objects uploaded to {}/{}",
                args.bucket,
                args.prefix.trim_matches('/')
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}
