#!/bin/bash
# Reads the Worker's error logs out of the private bucket.
#
# Log Explorer is a paid add-on and `wrangler tail` only shows what happens
# while it is running, so these objects are the record of anything that failed
# while nobody was watching. The Worker writes one per failed request, under
# logs/<day>/, and this prints them newest first.
#
# Read-only credentials on purpose: looking at a log must never be able to
# change anything. They are the same R2_PRIVATE_RO pair the media workflow uses.
#
# Usage:
#   bash scripts/read-error-logs.sh                  # 10 most recent failures
#   bash scripts/read-error-logs.sh -n 40            # more of them
#   bash scripts/read-error-logs.sh -d 2026-08-06    # one day only
#   bash scripts/read-error-logs.sh -k               # keys, nothing else
#   bash scripts/read-error-logs.sh logs/2026-08-06/122431123-4f2a9c1e.json
#
# Exit code 0 = printed (including "nothing to print"), 1 = could not read.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infrastructure/.env"
worker_env="$repo_root/worker/.env"
tfvars="$repo_root/infrastructure/main/config.auto.tfvars"

limit=10
day=""
keys_only=0
single_key=""

while [ $# -gt 0 ]; do
  case "$1" in
    -n) limit="${2:?-n needs a number}"; shift 2 ;;
    -d) day="${2:?-d needs a date, e.g. 2026-08-06}"; shift 2 ;;
    -k) keys_only=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    logs/*) single_key="$1"; shift ;;
    *) echo "Unrecognised argument: $1" >&2; exit 1 ;;
  esac
done

[ -f "$env_file" ] || { echo "Not found: infrastructure/.env" >&2; exit 1; }
[ -f "$worker_env" ] || { echo "Not found: worker/.env" >&2; exit 1; }

# shellcheck disable=SC1090
set -a; . "$env_file"; . "$worker_env"; set +a

: "${R2_PRIVATE_RO_ACCESS_KEY_ID:?not set in infrastructure/.env}"
: "${R2_PRIVATE_RO_SECRET_ACCESS_KEY:?not set in infrastructure/.env}"
: "${PRIVATE_BUCKET:?not set in worker/.env}"

# Give Podman only the names to inherit. Expanding either credential in a
# `podman run` argument would expose it through the host's process list.
export AWS_ACCESS_KEY_ID="$R2_PRIVATE_RO_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_PRIVATE_RO_SECRET_ACCESS_KEY"
export AWS_REGION=auto

# The account id lives in the Terraform config rather than either .env, so take
# it from there unless the environment already carries one.
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ -f "$tfvars" ]; then
  CLOUDFLARE_ACCOUNT_ID=$(sed -nE 's/^[[:space:]]*cloudflare_account_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$tfvars")
fi
: "${CLOUDFLARE_ACCOUNT_ID:?not set, and not found in infrastructure/main/config.auto.tfvars}"

endpoint="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

# aws-cli runs in a container so nothing has to be installed on the host. The
# credentials go in as environment variables rather than a mounted profile, so
# they never touch a file inside the container.
r2() {
  podman run --rm \
    -e AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY \
    -e AWS_REGION \
    docker.io/amazon/aws-cli:latest \
    --endpoint-url "$endpoint" "$@"
}

fetch_key() {
  # aws-cli writes the object to a file, so send it to the container's own
  # stdout via /dev/stdout rather than mounting anything from the host.
  r2 s3api get-object --bucket "$PRIVATE_BUCKET" --key "$1" /dev/stdout 2>/dev/null |
    # get-object appends its JSON result metadata after the body; the body is
    # the first complete JSON value, which jq reads and the rest is discarded.
    jq -s '.[0]'
}

if [ -n "$single_key" ]; then
  fetch_key "$single_key"
  exit 0
fi

prefix="logs/"
[ -n "$day" ] && prefix="logs/$day/"

# Capture the listing before parsing it. `mapfile` does not propagate the
# status of a command in process substitution, so putting `r2` there would turn
# expired credentials or an API outage into a false "No error logs" success.
if ! listing=$(
  r2 s3api list-objects-v2 --bucket "$PRIVATE_BUCKET" --prefix "$prefix" \
    --query 'Contents[].Key' --output text
); then
  echo "Could not list error logs under $prefix." >&2
  exit 1
fi

# Keys begin with the UTC timestamp, so sorting them is sorting by time.
mapfile -t found < <(
  printf '%s\n' "$listing" | tr '\t' '\n' | grep -v '^None$' | sort -r | head -n "$limit"
)

if [ "${#found[@]}" -eq 0 ]; then
  echo "No error logs under $prefix — nothing has failed, or nothing has run."
  exit 0
fi

if [ "$keys_only" -eq 1 ]; then
  printf '%s\n' "${found[@]}"
  exit 0
fi

for key in "${found[@]}"; do
  echo "───────────────────────────────────────────────────────────────"
  echo "$key"
  fetch_key "$key" | jq -r '
    "\(.at)  \(.method) \(.path)  → \(.status)  (\(.durationMs)ms)",
    (.entries[] | "  [\(.level)] \(.message)")
  '
done
