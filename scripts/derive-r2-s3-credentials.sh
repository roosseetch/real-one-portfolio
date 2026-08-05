#!/bin/bash
# Derives S3-compatible R2 credentials from the Cloudflare API token already in
# infrastructure/.env, and writes them back as AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY.
#
# Cloudflare lets any API token with R2 permissions act as an S3 credential
# pair: the access key id is the token's own id, and the secret is the SHA-256
# of the token value. That avoids minting a second, separately-scoped R2 token
# whose reach then has to be kept in sync with the first.
#   https://developers.cloudflare.com/r2/api/tokens/
#
# The token is sent only to Cloudflare's own verify endpoint. Nothing is
# printed: the derived values go straight into the gitignored .env.
#
# Usage: bash scripts/derive-r2-s3-credentials.sh
# Exit code 0 = credentials written, 1 = anything went wrong.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infrastructure/.env"

[ -f "$env_file" ] || {
  echo "Not found: infrastructure/.env" >&2
  exit 1
}

# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || {
  echo "CLOUDFLARE_API_TOKEN is not set in infrastructure/.env" >&2
  exit 1
}

response=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify)

if [ "$(printf '%s' "$response" | jq -r '.success')" != "true" ]; then
  # Cloudflare's own error text; it does not echo the token back.
  printf '%s' "$response" | jq -r '.errors[]?.message' >&2
  echo "Could not verify CLOUDFLARE_API_TOKEN." >&2
  exit 1
fi

access_key_id=$(printf '%s' "$response" | jq -r '.result.id')
secret_access_key=$(printf '%s' "$CLOUDFLARE_API_TOKEN" | sha256sum | cut -d' ' -f1)

[ -n "$access_key_id" ] && [ "$access_key_id" != "null" ] || {
  echo "Cloudflare did not return a token id." >&2
  exit 1
}

cp "$env_file" "$env_file.bak"

# Drop any existing lines for these two, then append the derived pair.
grep -vE '^export (AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=' "$env_file.bak" > "$env_file"
{
  echo "export AWS_ACCESS_KEY_ID=$access_key_id"
  echo "export AWS_SECRET_ACCESS_KEY=$secret_access_key"
} >> "$env_file"

chmod 600 "$env_file"

echo "Wrote AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to infrastructure/.env"
echo "Previous file kept at infrastructure/.env.bak (also gitignored)."
echo "These credentials inherit the API token's R2 scope, so they reach every bucket it can."
