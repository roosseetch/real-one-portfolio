#!/usr/bin/env python3
"""Uploads sanitized derivatives to the public media bucket.

Reads CLOUDFLARE_API_TOKEN from the environment. Refuses to upload anything
that still carries identifying metadata, so a sanitization failure cannot
become a public object.

Usage: upload-media.py <work-dir> <bucket> <key-prefix>
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
API = "https://api.cloudflare.com/client/v4"

# Profile images keep stable filenames, so they cannot be cached forever the way
# immutable record chunks are. A week is long enough to be cheap and short
# enough that a replacement propagates without a manual purge.
CACHE_CONTROL = "public, max-age=604800"

BLOCKED_TAGS = ("SerialNumber", "OwnerName", "Artist", "Software", "UserComment")


def account_id() -> str:
    req = urllib.request.Request(f"{API}/accounts", headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read())["result"][0]["id"]


def is_clean(path: Path) -> bool:
    out = subprocess.run(["exiftool", "-json", "-G", str(path)], capture_output=True, text=True, check=True)
    tags = json.loads(out.stdout)[0]
    return not any(k.endswith(f":{t}") for k in tags for t in BLOCKED_TAGS)


work_dir, bucket, prefix = Path(sys.argv[1]), sys.argv[2], sys.argv[3].strip("/")
acct = account_id()
uploaded = 0

for path in sorted(work_dir.glob("*.webp")):
    if not is_clean(path):
        sys.exit(f"refusing to upload {path.name}: identifying metadata present")

    key = f"{prefix}/{path.name}"
    req = urllib.request.Request(
        f"{API}/accounts/{acct}/r2/buckets/{bucket}/objects/{key}",
        data=path.read_bytes(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "image/webp",
            "Cache-Control": CACHE_CONTROL,
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read())
        print(f"  {key:44} {path.stat().st_size / 1024:6.1f} KiB  ok={body.get('success')}")
        uploaded += 1
    except urllib.error.HTTPError as err:
        sys.exit(f"upload failed for {key}: HTTP {err.code} {err.read().decode()[:200]}")

print(f"\n{uploaded} objects uploaded to {bucket}/{prefix}/")
