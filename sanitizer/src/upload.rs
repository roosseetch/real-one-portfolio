//! Putting sanitised derivatives into the public media bucket.
//!
//! This replaces two uploaders that did the same job by different means: a
//! Python script for the profile photographs, run by hand, and three sequential
//! `aws s3 cp --recursive` passes in the media workflow, one per extension,
//! because the CLI cannot name more than one content type in a single copy.
//! Neither could see the other, and they had drifted -- most consequentially in
//! what they considered identifying metadata, where the Python checked five tags
//! to the sanitiser's eleven.
//!
//! Both credential paths live here for the same reason. The workflow holds an
//! S3 access key scoped to write this one bucket; a person publishing a profile
//! photograph holds a Cloudflare API token. Asking either to hold the other's
//! credential to use one code path would widen what a runner carries or add a
//! secret to a laptop, so the binary speaks both and each caller keeps what it
//! already has.
//!
//! Nothing here decides what a derivative is called or how long it may be
//! cached. Those come from the caller, because the two callers genuinely differ:
//! an activity derivative carries its width in its name and is immutable, while
//! a profile photograph keeps a stable name and can only be cached for a week.

use anyhow::{anyhow, bail, Context, Result};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::image::identifying_tags;

/// What R2 is told to serve each extension as.
///
/// Naming them is not a formality. R2 serves back whatever it was told, and an
/// MP4 delivered as `binary/octet-stream` makes Safari refuse to play it inline
/// and Chrome download it instead. An extension missing from this table is a
/// hard error rather than a guess -- see [`plan`].
const CONTENT_TYPES: &[(&str, &str)] = &[
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("png", "image/png"),
    ("mp4", "video/mp4"),
];

/// The sanitiser's own record of what it wrote. It travels to the Worker
/// through the workflow's callback, never into the public bucket.
const NEVER_UPLOAD: &[&str] = &["manifest.json"];

pub fn content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    CONTENT_TYPES
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, kind)| *kind)
}

/// How long the objects in one upload may be cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cache {
    /// Activity derivatives. The media id and the width are in the name, so a
    /// changed picture is a new name rather than a new body at an old one.
    Immutable,
    /// Profile photographs and the site icon, which keep stable names and so
    /// cannot be cached forever. A week is long enough to be cheap and short
    /// enough that a replacement propagates without a manual purge -- which
    /// matters, because the token that publishes them cannot purge the CDN.
    Week,
}

impl Cache {
    pub fn header(self) -> &'static str {
        match self {
            Cache::Immutable => "public, max-age=31536000, immutable",
            Cache::Week => "public, max-age=604800",
        }
    }
}

/// One object about to be written.
#[derive(Debug, Clone)]
pub struct Upload {
    pub path: PathBuf,
    pub key: String,
    pub content_type: &'static str,
}

/// Everything in `dir` that is going to be uploaded, or an error naming what
/// stopped it.
///
/// Refusing before the first PUT rather than after the last is the point. The
/// shell this replaces checked for unrecognised files *after* uploading the
/// good ones, so a stray file failed the job only once the rest were already
/// public -- and a public object cannot be unpublished by failing a step.
pub fn plan(dir: &Path, prefix: &str) -> Result<Vec<Upload>> {
    let prefix = prefix.trim_matches('/');

    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("could not read {}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    entries.sort();

    let mut uploads = Vec::new();
    let mut strays = Vec::new();

    for path in entries {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => {
                strays.push(path.display().to_string());
                continue;
            }
        };
        if NEVER_UPLOAD.contains(&name.as_str()) {
            continue;
        }
        match content_type(&path) {
            Some(kind) => uploads.push(Upload {
                key: format!("{prefix}/{name}"),
                path,
                content_type: kind,
            }),
            None => strays.push(name),
        }
    }

    if !strays.is_empty() {
        bail!("no content type is defined for: {}", strays.join(", "));
    }
    Ok(uploads)
}

/// Reads every picture back and refuses the whole upload if any of them still
/// carries something identifying.
///
/// The same reader the sanitiser checks its own output with, so there is one
/// definition of what counts. It reads EXIF, which means it has nothing to say
/// about an MP4 -- a video's provenance hides in container atoms this parser
/// does not open. The media workflow runs exiftool and ffprobe over those
/// separately and before this ever runs; a video reaching here has already been
/// through a stricter check than this one could apply.
pub fn refuse_if_identifying(uploads: &[Upload]) -> Result<()> {
    let mut offences = Vec::new();
    for upload in uploads {
        if upload.content_type.starts_with("video/") {
            continue;
        }
        let leaked = identifying_tags(&upload.path);
        if !leaked.is_empty() {
            offences.push(format!(
                "{}: {}",
                upload
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                leaked.join(", ")
            ));
        }
    }
    if !offences.is_empty() {
        bail!(
            "refusing to upload, identifying metadata present -- {}",
            offences.join("; ")
        );
    }
    Ok(())
}

/// How this run authenticates to R2.
pub enum Credentials {
    /// A Cloudflare API token, against Cloudflare's own REST API. What a person
    /// publishing a profile photograph has, and it needs nothing installed.
    Token { token: String, account: String },
    /// An R2 S3 access key pair, against the S3 endpoint. What the media
    /// workflow's write-only credential is.
    S3 {
        access_key_id: String,
        secret_access_key: String,
        endpoint: String,
        region: String,
    },
}

impl Credentials {
    /// Reads whichever is present, preferring the token.
    ///
    /// The order matters only where both are set, which is a laptop that has
    /// exported the workflow's keys for some other purpose. The token is the
    /// one a person chose to use.
    pub fn from_env(agent: &ureq::Agent) -> Result<Self> {
        if let Ok(token) = std::env::var("CLOUDFLARE_API_TOKEN") {
            if !token.is_empty() {
                let account = match std::env::var("CLOUDFLARE_ACCOUNT_ID") {
                    Ok(id) if !id.is_empty() => id,
                    _ => discover_account(agent, &token)?,
                };
                return Ok(Credentials::Token { token, account });
            }
        }

        let access_key_id = std::env::var("AWS_ACCESS_KEY_ID").unwrap_or_default();
        let secret_access_key = std::env::var("AWS_SECRET_ACCESS_KEY").unwrap_or_default();
        if access_key_id.is_empty() || secret_access_key.is_empty() {
            bail!(
                "no credentials: set CLOUDFLARE_API_TOKEN, or AWS_ACCESS_KEY_ID and \
                 AWS_SECRET_ACCESS_KEY with AWS_ENDPOINT_URL_S3"
            );
        }
        let endpoint = std::env::var("AWS_ENDPOINT_URL_S3")
            .or_else(|_| std::env::var("AWS_ENDPOINT_URL"))
            .map_err(|_| anyhow!("AWS_ENDPOINT_URL_S3 is not set"))?;
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "auto".into());

        Ok(Credentials::S3 {
            access_key_id,
            secret_access_key,
            endpoint: endpoint.trim_end_matches('/').to_string(),
            region,
        })
    }

    pub fn describe(&self) -> &'static str {
        match self {
            Credentials::Token { .. } => "Cloudflare API token",
            Credentials::S3 { .. } => "R2 S3 access key",
        }
    }
}

/// The account a token can see, when the environment has not already said.
///
/// Takes the first, as the two scripts this replaces both did. A token minted
/// for this project sees exactly one account; if it ever sees more, naming
/// CLOUDFLARE_ACCOUNT_ID is the way to be sure which, and that is checked first.
fn discover_account(agent: &ureq::Agent, token: &str) -> Result<String> {
    let body: serde_json::Value = agent
        .get("https://api.cloudflare.com/client/v4/accounts")
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .context("could not list accounts")?
        .into_json()?;

    body["result"][0]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the token can see no account"))
}

/// Percent-encodes one path segment the way SigV4 and the REST API both want.
///
/// Unreserved characters pass through; everything else becomes %XX in upper
/// case. The keys this writes are Crockford base32 ids, widths and known
/// extensions, so in practice nothing is encoded -- but the key is pasted into
/// a URL, and a helper that is right only for the input it happens to get is
/// the kind that stops being right later.
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn encode_key(key: &str) -> String {
    key.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes.as_ref());
    format!("{:x}", hasher.finalize())
}

fn hmac(key: &[u8], message: &str) -> Vec<u8> {
    use hmac::{Mac, SimpleHmac};
    let mut mac = SimpleHmac::<sha2::Sha256>::new_from_slice(key).expect("HMAC takes any key size");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// `20260909T112233Z` and `20260909`, which SigV4 wants both of.
fn timestamps() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;

    // Civil-from-days, so this needs no date crate for the one format it emits.
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    let date = format!("{y:04}{m:02}{d:02}");
    (format!("{date}T{hh:02}{mm:02}{ss:02}Z"), date)
}

/// Signs and sends one PUT to the S3 endpoint.
///
/// Only the headers that carry meaning are signed -- host, both content
/// headers, and the two `x-amz-*` ones, which SigV4 requires be signed whenever
/// they are sent. The payload hash is the real one rather than UNSIGNED-PAYLOAD:
/// the bytes are already in memory and hashing them is the cheapest part of the
/// request, so the signature covers what was actually written.
#[allow(clippy::too_many_arguments)]
fn put_s3(
    agent: &ureq::Agent,
    access_key_id: &str,
    secret_access_key: &str,
    endpoint: &str,
    region: &str,
    bucket: &str,
    upload: &Upload,
    cache: Cache,
    body: &[u8],
) -> Result<()> {
    let host = endpoint
        .split("://")
        .nth(1)
        .ok_or_else(|| anyhow!("endpoint {endpoint} has no scheme"))?
        .trim_end_matches('/');
    let path = format!("/{}/{}", encode_segment(bucket), encode_key(&upload.key));
    let (amz_date, date) = timestamps();
    let payload_hash = hex(body);
    let cache_header = cache.header();

    let canonical = format!(
        "PUT\n{path}\n\n\
         cache-control:{cache_header}\n\
         content-type:{content_type}\n\
         host:{host}\n\
         x-amz-content-sha256:{payload_hash}\n\
         x-amz-date:{amz_date}\n\n\
         {signed}\n{payload_hash}",
        content_type = upload.content_type,
        signed = "cache-control;content-type;host;x-amz-content-sha256;x-amz-date",
    );

    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex(canonical.as_bytes())
    );

    let mut key = hmac(format!("AWS4{secret_access_key}").as_bytes(), &date);
    for part in [region, "s3", "aws4_request"] {
        key = hmac(&key, part);
    }
    let signature = hmac(&key, &to_sign)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, \
         SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, \
         Signature={signature}"
    );

    send(
        agent
            .put(&format!("{endpoint}{path}"))
            .set("Authorization", &authorization)
            .set("x-amz-date", &amz_date)
            .set("x-amz-content-sha256", &payload_hash)
            .set("Content-Type", upload.content_type)
            .set("Cache-Control", cache_header),
        body,
        &upload.key,
    )
}

/// Sends one PUT through Cloudflare's REST API, which needs no signing.
fn put_token(
    agent: &ureq::Agent,
    token: &str,
    account: &str,
    bucket: &str,
    upload: &Upload,
    cache: Cache,
    body: &[u8],
) -> Result<()> {
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{bucket}/objects/{}",
        encode_key(&upload.key)
    );
    send(
        agent
            .put(&url)
            .set("Authorization", &format!("Bearer {token}"))
            .set("Content-Type", upload.content_type)
            .set("Cache-Control", cache.header()),
        body,
        &upload.key,
    )
}

/// The one place a response is turned into an error, so both paths report the
/// same way. The body is truncated: a failure names a bucket and a key, and an
/// unbounded provider response in a log is how the rest of a URL gets there too.
fn send(request: ureq::Request, body: &[u8], key: &str) -> Result<()> {
    match request.send_bytes(body) {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, response)) => {
            let detail = response.into_string().unwrap_or_default();
            bail!(
                "upload failed for {key}: HTTP {code} {}",
                &detail[..detail.len().min(200)]
            )
        }
        Err(err) => bail!("upload failed for {key}: {err}"),
    }
}

/// Writes every planned object, in parallel, and reports how many went.
///
/// Concurrent because these are independent PUTs of a few hundred kilobytes
/// each over one connection pool, and the three `aws s3 cp` passes this
/// replaces were sequential by construction -- one process per extension.
pub fn upload_all(
    agent: &ureq::Agent,
    credentials: &Credentials,
    bucket: &str,
    uploads: &[Upload],
    cache: Cache,
) -> Result<()> {
    let results: Vec<Result<()>> = uploads
        .par_iter()
        .map(|upload| {
            let body = std::fs::read(&upload.path)
                .with_context(|| format!("could not read {}", upload.path.display()))?;
            match credentials {
                Credentials::Token { token, account } => {
                    put_token(agent, token, account, bucket, upload, cache, &body)
                }
                Credentials::S3 {
                    access_key_id,
                    secret_access_key,
                    endpoint,
                    region,
                } => put_s3(
                    agent,
                    access_key_id,
                    secret_access_key,
                    endpoint,
                    region,
                    bucket,
                    upload,
                    cache,
                    &body,
                ),
            }
        })
        .collect();

    let failures: Vec<String> = results
        .into_iter()
        .filter_map(|result| result.err().map(|err| err.to_string()))
        .collect();

    if !failures.is_empty() {
        bail!(
            "{} of {} objects failed:\n  {}",
            failures.len(),
            uploads.len(),
            failures.join("\n  ")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_content_type_for_every_format_the_pipeline_writes() {
        assert_eq!(content_type(Path::new("a-800.webp")), Some("image/webp"));
        assert_eq!(content_type(Path::new("a-800.avif")), Some("image/avif"));
        assert_eq!(content_type(Path::new("mark-730.png")), Some("image/png"));
        assert_eq!(content_type(Path::new("a-1920.mp4")), Some("video/mp4"));
    }

    /// R2 serves back whatever it was told, so guessing is worse than refusing.
    #[test]
    fn refuses_to_guess_at_anything_else() {
        assert_eq!(content_type(Path::new("notes.txt")), None);
        assert_eq!(content_type(Path::new("no-extension")), None);
    }

    #[test]
    fn is_not_fooled_by_a_capitalised_extension() {
        assert_eq!(content_type(Path::new("A-800.WEBP")), Some("image/webp"));
    }

    #[test]
    fn the_two_cache_policies_say_what_they_mean() {
        assert!(Cache::Immutable.header().contains("immutable"));
        assert_eq!(Cache::Week.header(), "public, max-age=604800");
    }

    #[test]
    fn encodes_a_key_without_touching_its_separators() {
        assert_eq!(
            encode_key("media/activity-a/b-800.webp"),
            "media/activity-a/b-800.webp"
        );
        assert_eq!(
            encode_key("media/profile/a b.webp"),
            "media/profile/a%20b.webp"
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("upload-plan-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn plans_one_object_per_file_under_the_prefix() {
        let dir = scratch("basic");
        for name in ["b-320.webp", "b-320.avif", "b.mp4"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }

        let plan = plan(&dir, "/media/activity-a/").unwrap();

        assert_eq!(
            plan.iter().map(|u| u.key.as_str()).collect::<Vec<_>>(),
            [
                "media/activity-a/b-320.avif",
                "media/activity-a/b-320.webp",
                "media/activity-a/b.mp4"
            ]
        );
    }

    /// The sanitiser writes it beside the derivatives and the Worker reads it
    /// through the callback. It has never belonged in the public bucket.
    #[test]
    fn leaves_the_manifest_where_it_is() {
        let dir = scratch("manifest");
        std::fs::write(dir.join("manifest.json"), b"{}").unwrap();
        std::fs::write(dir.join("b-320.webp"), b"x").unwrap();

        let plan = plan(&dir, "media/activity-a").unwrap();

        assert_eq!(plan.len(), 1);
        assert!(plan[0].key.ends_with("b-320.webp"));
    }

    /// Before the first PUT, not after the last: the shell this replaces checked
    /// afterwards, so a stray file failed the job with the rest already public.
    #[test]
    fn refuses_the_whole_run_when_a_file_has_no_content_type() {
        let dir = scratch("stray");
        std::fs::write(dir.join("b-320.webp"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();

        let err = plan(&dir, "media/activity-a").unwrap_err().to_string();

        assert!(err.contains("notes.txt"), "{err}");
    }
}
