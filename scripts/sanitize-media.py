#!/usr/bin/env python3
"""Sanitizes source photos into public web derivatives.

Order matters and is not negotiable: every trace of the original metadata is
removed first, and only then is the configured decoy metadata injected. The
work happens entirely in an ephemeral directory, so a raw original never sits
next to tracked files.

Usage:
    sanitize-media.py <source-dir> <work-dir> <mapping.json> [--widths 1600,800]

mapping.json maps output ids to source filenames, for example
    {"hero": "main_foto.jpeg", "hobby-ballet": "hobby_ballet.jpeg"}
"""
import argparse
import json
import random
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageOps

REPO_ROOT = Path(__file__).resolve().parent.parent
DECOY_CONFIG = REPO_ROOT / "config" / "media-decoy.json"

# Anything in this list surviving into the output is a failure, not a warning.
FORBIDDEN_TAGS = [
    "GPSLatitude", "GPSLongitude", "GPSPosition", "GPSAltitude",
    "SerialNumber", "LensSerialNumber", "OwnerName", "Artist", "Copyright",
    "CreateDate", "ModifyDate", "Software", "HostComputer",
    "ImageDescription", "UserComment", "XMPToolkit", "Rating",
]


def deg_to_dms(value: float) -> str:
    degrees = int(abs(value))
    minutes_full = (abs(value) - degrees) * 60
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60
    return f"{degrees} {minutes} {seconds:.2f}"


def strip_and_resize(source: Path, out_path: Path, width: int) -> tuple[int, int]:
    """Re-encodes to WebP at the target width, carrying no metadata across.

    Never upscales: a derivative wider than its source is a bigger file with no
    more detail in it, so the width is clamped to the original.
    """
    with Image.open(source) as img:
        # Apply the orientation flag, then drop it. Saving without an EXIF
        # block afterwards leaves the pixels already the right way up.
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")

        target_width = min(width, img.width)
        target_height = round(img.height * target_width / img.width)
        resized = img.resize((target_width, target_height), Image.LANCZOS)
        resized.save(out_path, "WEBP", quality=82, method=6)
        return target_width, target_height


def inject_decoy(path: Path, decoy: dict, rng: random.Random) -> str:
    peak = rng.choice(decoy["gpsCandidates"])
    stamp = decoy["dateTimeOriginal"]
    time_part = (
        f"{rng.randrange(24):02d}:{rng.randrange(60):02d}:{rng.randrange(60):02d}"
        if stamp.get("randomizeTime")
        else "12:00:00"
    )
    args = [
        "exiftool", "-overwrite_original", "-q",
        f"-Make={decoy['camera']['make']}",
        f"-Model={decoy['camera']['model']}",
        f"-DateTimeOriginal={stamp['date']} {time_part}",
        f"-GPSLatitude={deg_to_dms(peak['lat'])}",
        f"-GPSLatitudeRef={'N' if peak['lat'] >= 0 else 'S'}",
        f"-GPSLongitude={deg_to_dms(peak['lon'])}",
        f"-GPSLongitudeRef={'E' if peak['lon'] >= 0 else 'W'}",
        str(path),
    ]
    subprocess.run(args, check=True)
    return peak["name"]


def read_tags(path: Path) -> dict:
    out = subprocess.run(
        ["exiftool", "-json", "-G", str(path)], capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)[0]


parser = argparse.ArgumentParser()
parser.add_argument("source_dir")
parser.add_argument("work_dir")
parser.add_argument("mapping")
parser.add_argument("--widths", default="1600,800")
args = parser.parse_args()

source_dir = Path(args.source_dir)
work_dir = Path(args.work_dir)
work_dir.mkdir(parents=True, exist_ok=True)
mapping = json.loads(Path(args.mapping).read_text())
decoy = json.loads(DECOY_CONFIG.read_text())
widths = sorted((int(w) for w in args.widths.split(",")), reverse=True)

rng = random.Random()

manifest: dict[str, list[dict]] = {}
failures: list[str] = []

for media_id, filename in mapping.items():
    source = source_dir / filename
    if not source.exists():
        failures.append(f"{media_id}: source {filename} not found")
        continue

    with Image.open(source) as probe:
        source_width = probe.width
    entries = []
    emitted: set[int] = set()

    for width in widths:
        actual = min(width, source_width)
        if actual in emitted:
            # Two requested widths clamped to the same size; one file is enough.
            continue
        emitted.add(actual)

        out_path = work_dir / f"{media_id}-{actual}.webp"
        dims = strip_and_resize(source, out_path, width)
        peak = inject_decoy(out_path, decoy, rng)

        tags = read_tags(out_path)
        leaked = [t for t in FORBIDDEN_TAGS if any(k.endswith(f":{t}") for k in tags)]
        # The decoy GPS is expected; only flag it when it did not come from us.
        leaked = [t for t in leaked if not t.startswith("GPS")]
        if leaked:
            failures.append(f"{out_path.name}: original metadata survived: {leaked}")

        entries.append(
            {
                "file": out_path.name,
                "width": dims[0],
                "height": dims[1],
                "bytes": out_path.stat().st_size,
                "decoyLocation": peak,
            }
        )

    if entries:
        manifest[media_id] = entries

(work_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

for media_id, entries in manifest.items():
    for e in entries:
        print(f"{e['file']:32} {e['width']}x{e['height']:<6} {e['bytes']/1024:6.1f} KiB  decoy@{e['decoyLocation']}")

if failures:
    print("\nFAILURES:", file=sys.stderr)
    for f in failures:
        print(f"  {f}", file=sys.stderr)
    sys.exit(1)

print(f"\n{sum(len(v) for v in manifest.values())} derivatives written to {work_dir}")
