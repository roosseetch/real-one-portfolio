#!/usr/bin/env python3
"""Sanitizes source photos and videos into public web derivatives.

Order matters and is not negotiable: every trace of the original metadata is
removed first, and only then is the configured decoy metadata injected. The
work happens entirely in an ephemeral directory, so a raw original never sits
next to tracked files.

Removal is by re-encode rather than by deletion. A picture goes through Pillow,
which writes no EXIF unless asked; a video is transcoded to H.264/AAC with every
metadata dictionary dropped. Deleting tags from the original file would leave
whatever the deleter did not know to look for -- and for a video that is a great
deal, since a phone writes its clock, its model and its coordinates into places
a tag editor does not reach.

Usage:
    sanitize_media.py <source-dir> <work-dir> <mapping.json> [--widths 1600,800]

mapping.json maps output ids to a source file and its kind, for example
    {"hero": {"file": "main_foto.jpeg", "type": "image"},
     "clip": {"file": "morning_run.mov", "type": "video"}}
"""
import argparse
import json
import random
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
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

# What a sanitised container is still allowed to say about itself. Everything
# else ffprobe can read is either the camera's or the encoder's, and both are
# facts about the author that the published file has no reason to carry.
ALLOWED_CONTAINER_TAGS = {
    "major_brand", "minor_version", "compatible_brands", "language",
    # Written by us, deliberately, and checked against what we wrote.
    "make", "model", "com.apple.quicktime.make", "com.apple.quicktime.model",
    "location", "com.apple.quicktime.location.iso6709",
}

# Three tags the MP4 muxer writes whatever it is told, so they cannot be removed
# -- only made to say nothing. They are checked by value rather than waved
# through by name, because the *value* is the whole difference: a bitexact
# transcode writes "VideoHandler", a zeroed vendor and a versionless encoder,
# where an iPhone's original says "Core Media Video" and a non-bitexact one says
# "Lavc60.31.102 libx264". Allowing the keys outright would let an untranscoded
# passthrough travel as though it had been sanitised.
MUXER_CONSTANTS = {
    "handler_name": {"", "videohandler", "soundhandler", "subtitlehandler"},
    "vendor_id": {"", "[0][0][0][0]"},
}
VERSIONLESS_ENCODER = "lavc "


def deg_to_dms(value: float) -> str:
    degrees = int(abs(value))
    minutes_full = (abs(value) - degrees) * 60
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60
    return f"{degrees} {minutes} {seconds:.2f}"


def iso6709(lat: float, lon: float) -> str:
    """The one location format an MP4 container understands, per ISO 6709.

    Signed, fixed-width, and closed with a solidus. QuickTime readers that meet
    an unterminated string treat the whole atom as malformed.
    """
    return f"{lat:+09.4f}{lon:+010.4f}/"


def load_decoy() -> dict:
    return json.loads(DECOY_CONFIG.read_text())


def decoy_time(stamp: dict, rng: random.Random) -> str:
    return (
        f"{rng.randrange(24):02d}:{rng.randrange(60):02d}:{rng.randrange(60):02d}"
        if stamp.get("randomizeTime")
        else "12:00:00"
    )


def read_tags(path: Path) -> dict:
    out = subprocess.run(
        ["exiftool", "-json", "-G", str(path)], capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)[0]


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

# WebP is what the site asks for; AVIF is offered alongside it where the encoder
# is available, since a browser that understands it gets a smaller file for the
# same picture. Its absence is not a failure: the WebP is always written.
FORMATS = [("webp", "WEBP", {"quality": 82, "method": 6}), ("avif", "AVIF", {"quality": 60})]


def flatten(img: Image.Image) -> Image.Image:
    """Composites transparency onto white before the alpha channel is dropped.

    `convert("RGB")` does not blend -- it discards the alpha and keeps whatever
    colour sat under it, which is black almost everywhere it matters. A WebP
    nearly always carries an alpha channel, so without this the format the
    intake was widened to accept publishes with black where it should be clear.
    """
    transparent = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    if not transparent:
        return img.convert("RGB")

    rgba = img.convert("RGBA")
    canvas = Image.new("RGB", rgba.size, (255, 255, 255))
    canvas.paste(rgba, mask=rgba.getchannel("A"))
    return canvas


def strip_and_resize(source: Path, out_path: Path, width: int, pillow_format: str, options: dict) -> tuple[int, int]:
    """Re-encodes at the target width, carrying no metadata across.

    Never upscales: a derivative wider than its source is a bigger file with no
    more detail in it, so the width is clamped to the original.
    """
    with Image.open(source) as img:
        # Apply the orientation flag, then drop it. Saving without an EXIF
        # block afterwards leaves the pixels already the right way up.
        img = ImageOps.exif_transpose(img)
        img = flatten(img)

        target_width = min(width, img.width)
        target_height = round(img.height * target_width / img.width)
        resized = img.resize((target_width, target_height), Image.LANCZOS)
        resized.save(out_path, pillow_format, **options)
        return target_width, target_height


def inject_decoy(path: Path, decoy: dict, rng: random.Random, peak: dict | None = None) -> str | None:
    # A pinned peak is how a video's poster claims the same place as the video
    # it stands for. Left to itself each derivative draws its own, which is
    # harmless for a photo and would be a contradiction for a poster.
    peak = peak if peak is not None else rng.choice(decoy["gpsCandidates"])
    stamp = decoy["dateTimeOriginal"]
    args = [
        "exiftool", "-overwrite_original", "-q", "-m",
        f"-Make={decoy['camera']['make']}",
        f"-Model={decoy['camera']['model']}",
        f"-DateTimeOriginal={stamp['date']} {decoy_time(stamp, rng)}",
        f"-GPSLatitude={deg_to_dms(peak['lat'])}",
        f"-GPSLatitudeRef={'N' if peak['lat'] >= 0 else 'S'}",
        f"-GPSLongitude={deg_to_dms(peak['lon'])}",
        f"-GPSLongitudeRef={'E' if peak['lon'] >= 0 else 'W'}",
        str(path),
    ]
    # Spec §11.3: inject only where the container supports it. Removal has
    # already happened by re-encoding, so a format exiftool cannot write to is
    # still safe -- it simply carries no decoy.
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    return peak["name"]


def image_derivatives(
    source: Path,
    media_id: str,
    work_dir: Path,
    widths: list[int],
    decoy: dict,
    rng: random.Random,
    *,
    name: str | None = None,
    role: str = "image",
    peak: dict | None = None,
) -> tuple[list[dict], list[str], set[str]]:
    """Every web derivative of one picture, checked as it is written.

    `name` overrides the filename stem without changing which media id the
    entries belong to, which is how a video's poster frame comes out as
    `{media_id}-poster-{width}.webp` while still travelling with its video.
    """
    stem = name or media_id
    entries: list[dict] = []
    failures: list[str] = []
    skipped_formats: set[str] = set()

    with Image.open(source) as probe:
        probe = ImageOps.exif_transpose(probe)
        source_width = probe.width
        source_ratio = probe.width / probe.height
    emitted: set[int] = set()

    for width in widths:
        actual = min(width, source_width)
        if actual in emitted:
            # Two requested widths clamped to the same size; one file is enough.
            continue
        emitted.add(actual)

        for extension, pillow_format, options in FORMATS:
            out_path = work_dir / f"{stem}-{actual}.{extension}"
            try:
                dims = strip_and_resize(source, out_path, actual, pillow_format, options)
            except (OSError, KeyError, ValueError) as exc:
                # An encoder this build does not have. WebP is required and its
                # absence is a real failure; AVIF is a bonus.
                if extension == "webp":
                    failures.append(f"{media_id}: could not write WebP at {actual}px: {exc}")
                else:
                    skipped_formats.add(extension)
                continue

            written_peak = inject_decoy(out_path, decoy, rng, peak)

            tags = read_tags(out_path)
            leaked = [t for t in FORBIDDEN_TAGS if any(k.endswith(f":{t}") for k in tags)]
            # The decoy GPS is expected; only flag it when it did not come from us.
            leaked = [t for t in leaked if not t.startswith("GPS")]
            if leaked:
                failures.append(f"{out_path.name}: original metadata survived: {leaked}")

            # A derivative wider than its source would be an upscale, and one
            # that lost its shape would crop the subject out on the site.
            if dims[0] > source_width:
                failures.append(f"{out_path.name}: upscaled beyond the source width")
            if abs(dims[0] / dims[1] - source_ratio) > 0.01:
                failures.append(f"{out_path.name}: aspect ratio drifted from the source")
            if out_path.stat().st_size == 0:
                failures.append(f"{out_path.name}: written empty")

            entries.append(
                {
                    "file": out_path.name,
                    "format": extension,
                    "role": role,
                    "width": dims[0],
                    "height": dims[1],
                    "bytes": out_path.stat().st_size,
                    "decoyLocation": written_peak,
                }
            )

    return entries, failures, skipped_formats


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VideoProperties:
    """What the file is, as ffprobe reports it rather than as anything claims.

    `width` and `height` are *display* dimensions. A phone shooting in portrait
    stores 1920x1080 pixels plus a rotation matrix, and ffmpeg's autorotate bakes
    that matrix into the output pixels -- so comparing coded dimensions across
    the transcode reports a failure on every portrait video ever sent.
    """

    width: int
    height: int
    duration: float
    video_codec: str
    has_audio: bool
    audio_codec: str | None
    audio_channels: int | None
    rotation: int
    format_tags: dict = field(default_factory=dict)
    stream_tags: list[dict] = field(default_factory=list)


def _rotation_of(stream: dict) -> int:
    """Degrees of display rotation, from either place ffprobe reports it.

    Newer builds put it in side_data_list as a float; older ones leave it in the
    stream tags. Neither is metadata `-map_metadata` can reach.
    """
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            return int(round(float(side["rotation"]))) % 360
    tag = (stream.get("tags") or {}).get("rotate")
    if tag is not None:
        try:
            return int(round(float(tag))) % 360
        except ValueError:
            return 0
    return 0


def probe_video(path: Path) -> VideoProperties:
    """Reads the properties every later decision depends on.

    Raises on a file ffprobe cannot open, which is exactly the invalid-file
    case: something arrived named like a video and is not one.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise ValueError(f"ffprobe could not read it: {out.stderr.strip().splitlines()[-1:] or ['unreadable']}")

    probed = json.loads(out.stdout or "{}")
    streams = probed.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError("no video stream")

    # ffprobe reads a still picture as a one-frame video, so a JPEG that arrives
    # named .mp4 would otherwise transcode into a 0.04-second clip whose poster
    # frame is the picture itself. The Worker's own sniffing refuses to file one
    # as a video, but that is a check in another process; this is the one that
    # holds if the file ever gets here another way.
    if video.get("codec_name") in ("mjpeg", "png", "bmp", "gif", "webp", "tiff"):
        raise ValueError(f"a still {video.get('codec_name')} picture, not a video")

    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    rotation = _rotation_of(video)
    width, height = int(video.get("width", 0)), int(video.get("height", 0))
    if rotation in (90, 270):
        width, height = height, width
    if width == 0 or height == 0:
        raise ValueError("no usable dimensions")

    duration = float(probed.get("format", {}).get("duration") or video.get("duration") or 0.0)

    return VideoProperties(
        width=width,
        height=height,
        duration=duration,
        video_codec=video.get("codec_name", ""),
        has_audio=audio is not None,
        audio_codec=audio.get("codec_name") if audio else None,
        audio_channels=int(audio["channels"]) if audio and "channels" in audio else None,
        rotation=rotation,
        format_tags=probed.get("format", {}).get("tags", {}) or {},
        stream_tags=[s.get("tags", {}) or {} for s in streams],
    )


def scaled_size(props: VideoProperties, max_width: int) -> tuple[int, int]:
    """The output's display size: the input's, unless it is over the cap.

    Both dimensions are forced even, because yuv420p subsamples chroma by two
    and an odd dimension is not representable.
    """
    longest = max(props.width, props.height)
    if longest <= max_width:
        return props.width, props.height

    factor = max_width / longest
    width = max(2, int(round(props.width * factor)) & ~1)
    height = max(2, int(round(props.height * factor)) & ~1)
    return width, height


def transcode_args(
    source: Path,
    out_path: Path,
    props: VideoProperties,
    *,
    crf: int,
    preset: str,
    max_width: int,
) -> list[str]:
    """The ffmpeg command line, as a value, so it can be asserted on directly.

    Every flag here is either the transcode the spec asks for or a specific
    thing a camera writes that would otherwise survive it.
    """
    args = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        # Explicit stream selection, not the default. An iPhone MOV carries a
        # `tmcd` track holding the camera's clock and often an `mebx` track of
        # per-frame gyro and location samples. Defaults happen to drop them; a
        # map guarantees it.
        "-map", "0:v:0",
    ]
    if props.has_audio:
        args += ["-map", "0:a:0"]

    args += [
        # The global dictionary: com.apple.quicktime.location.ISO6709, .make,
        # .model, .software, creation_time, Android's com.android.version.
        "-map_metadata", "-1",
        # Per-stream metadata is copied from the matching input stream and
        # `-map_metadata -1` does not touch it. handler_name ("Core Media
        # Video"), vendor_id and per-stream creation_time all live here.
        "-map_metadata:s:v", "-1",
    ]
    if props.has_audio:
        args += ["-map_metadata:s:a", "-1"]
    args += ["-map_chapters", "-1"]

    args += [
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        # High profile at 8-bit 4:2:0 is what Safari on iOS will actually
        # decode. A 10-bit or 4:2:2 source would otherwise publish a file that
        # plays here and refuses to play there.
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        # Without this libx264 writes its own settings string into the first
        # frame as SEI user data -- "x264 - core 164 ... cabac=1 ref=3 ...",
        # which is encoder identification by any reading.
        "-flags:v", "+bitexact",
    ]

    width, height = scaled_size(props, max_width)
    if (width, height) != (props.width, props.height):
        args += ["-vf", f"scale={width}:{height}:flags=lanczos"]

    if props.has_audio:
        # No -ac and no -ar: forcing stereo upmixes a mono voice memo and
        # doubles its bitrate for nothing. Channels pass through and are
        # compared afterwards.
        args += ["-c:a", "aac", "-b:a", "128k", "-flags:a", "+bitexact"]
    else:
        args += ["-an"]

    args += [
        # As an output option this reaches the muxer: no "Lavf<version>" writing
        # application, and zeroed mvhd/tkhd/mdhd times rather than "now". A
        # fresh transcode otherwise stamps today's date into the container.
        "-fflags", "+bitexact",
        # moov ahead of mdat. The site serves this file straight off R2, so
        # without it a browser must fetch the whole body before the first frame.
        "-movflags", "+faststart",
        "-f", "mp4",
        str(out_path),
    ]
    return args


def extract_poster_args(video: Path, out_path: Path, duration: float) -> list[str]:
    """One frame, taken a moment in rather than at zero.

    Frame zero is black on anything that fades in, and halfway is wrong for a
    clip that ends on a title card, so a second in -- or the middle of anything
    shorter than two seconds.
    """
    offset = min(1.0, duration / 2) if duration > 0 else 0.0
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{offset:.3f}", "-i", str(video),
        "-map", "0:v:0", "-frames:v", "1", "-f", "image2", "-c:v", "png",
        str(out_path),
    ]


def extract_poster(video: Path, out_path: Path, duration: float) -> None:
    """Takes the poster from the sanitised output, never from the source.

    Two reasons, both structural: the poster then cannot show a frame the
    published video does not contain, and it cannot carry EXIF that the strip
    missed on the way past.
    """
    result = subprocess.run(extract_poster_args(video, out_path, duration), capture_output=True, text=True)
    if result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
        return

    # A clip shorter than the seek offset yields no frame at all.
    retry = subprocess.run(extract_poster_args(video, out_path, 0.0), capture_output=True, text=True)
    if retry.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
        raise ValueError("no frame could be read for a poster")


def moov_before_mdat(path: Path) -> bool:
    """Whether the file still starts playing before it finishes downloading.

    Walks the top-level box list: 4-byte big-endian size, 4-byte type, with
    size 1 meaning a 64-bit largesize follows and size 0 meaning "to the end".
    Worth checking because exiftool rewrites the file to add its atom, and
    whether faststart survives that is not something it promises.
    """
    with path.open("rb") as handle:
        offset = 0
        while True:
            handle.seek(offset)
            header = handle.read(8)
            if len(header) < 8:
                return False
            size = int.from_bytes(header[:4], "big")
            kind = header[4:8]
            if size == 1:
                largesize = handle.read(8)
                if len(largesize) < 8:
                    return False
                size = int.from_bytes(largesize, "big")
            elif size == 0:
                return kind == b"moov"

            if kind == b"moov":
                return True
            if kind == b"mdat":
                return False
            if size < 8:
                return False
            offset += size


def inject_video_decoy(path: Path, decoy: dict, rng: random.Random) -> dict | None:
    """Writes the decoy an MP4 can actually hold, and nothing it cannot.

    The photo decoy writes EXIF tags. An MP4 has no writable EXIF group, so
    every one of them would be refused -- correct by accident, but silent about
    what the container *can* carry. What it can carry is the QuickTime side:
    the Keys atoms under moov/udta/meta and the container dates.

    Deliberately not attempted: DateTimeOriginal, GPSLatitude/GPSLongitude as
    separate tags with their hemisphere refs, and Make/Model in the EXIF group.

    Nor the date, and that one is worth saying why. An MP4 stores its dates as
    32-bit seconds since 1904, which runs out in 2040 -- so the configured
    2117:03:03 does not fail to write, it *wraps*, and the file comes out
    claiming 1981-01-25. A decoy is meant to be an obvious fiction; a plausible
    wrong date is the opposite of one. The transcode's bitexact flags already
    zero every container date, so writing nothing leaves nothing, which is the
    honest outcome here. The pictures still carry the 2117 stamp: EXIF has no
    such ceiling.

    Returns the peak it claimed, or None when the write did not take -- the same
    contract as `inject_decoy`, for the same reason (spec §11.3). A tag that
    silently did not land is worse than an honest null.
    """
    peak = rng.choice(decoy["gpsCandidates"])
    coordinates = iso6709(peak["lat"], peak["lon"])

    result = subprocess.run(
        [
            "exiftool", "-overwrite_original", "-q", "-m",
            f"-Keys:Make={decoy['camera']['make']}",
            f"-Keys:Model={decoy['camera']['model']}",
            f"-Keys:GPSCoordinates={coordinates}",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or "Warning:" in (result.stderr or ""):
        return None

    # Read it back rather than trust the exit code: which of these an MP4
    # accepts varies by exiftool version, and a claimed decoy that is not there
    # would have the validation exempt a tag nothing wrote.
    if not any("GPSCoordinates" in k for k in read_tags(path)):
        return None
    return peak


def remux_faststart(path: Path) -> bool:
    """Puts moov back in front, keeping the tags and the bitstream as they are."""
    temp = path.with_suffix(".faststart.mp4")
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(path), "-map", "0", "-c", "copy", "-map_metadata", "0",
            # Bitexact here too: without it this second pass stamps its own
            # "Lavf<version>" back onto a file the transcode had just cleaned.
            "-fflags", "+bitexact",
            "-movflags", "+faststart", "-f", "mp4", str(temp),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not temp.exists():
        temp.unlink(missing_ok=True)
        return False
    temp.replace(path)
    return True


def compare_properties(
    before: VideoProperties,
    after: VideoProperties,
    *,
    expected_width: int,
    expected_height: int,
) -> list[str]:
    """What the transcode must have preserved, checked against what it did.

    The spec's acceptance criteria are literally in here: duration and audio
    survive, and nothing identifying does.
    """
    problems: list[str] = []

    tolerance = max(0.15, 0.02 * before.duration)
    if abs(after.duration - before.duration) > tolerance:
        problems.append(
            f"duration changed from {before.duration:.2f}s to {after.duration:.2f}s"
        )

    if before.has_audio and not after.has_audio:
        problems.append("audio was dropped")
    if after.has_audio and not before.has_audio:
        problems.append("audio appeared where the source had none")
    if before.has_audio and after.has_audio and before.audio_channels != after.audio_channels:
        problems.append(
            f"audio channels changed from {before.audio_channels} to {after.audio_channels}"
        )

    if (after.width, after.height) != (expected_width, expected_height):
        problems.append(
            f"dimensions are {after.width}x{after.height}, expected {expected_width}x{expected_height}"
        )
    if after.width > before.width or after.height > before.height:
        problems.append("upscaled beyond the source")
    if abs(after.width / after.height - before.width / before.height) > 0.01:
        problems.append("aspect ratio drifted from the source")

    if after.video_codec != "h264":
        problems.append(f"video is {after.video_codec or 'nothing'}, not H.264")
    if after.has_audio and after.audio_codec != "aac":
        problems.append(f"audio is {after.audio_codec}, not AAC")

    # A surviving display matrix means the pixels are not upright and the site
    # would have to rotate them itself.
    if after.rotation != 0:
        problems.append(f"a {after.rotation}-degree rotation survived into the output")

    return problems


def normalise_tag_key(key: str) -> str:
    """Drops the language suffix a QuickTime key can carry.

    The same value shows up twice, as `location` and `location-eng`, depending
    on whether the atom named a language. Comparing the suffixed form against a
    fixed list would flag our own decoy as a leak.
    """
    lowered = key.lower()
    parts = lowered.rsplit("-", 1)
    if len(parts) == 2 and len(parts[1]) == 3 and parts[1].isalpha():
        return parts[0]
    return lowered


def is_zeroed_date(value: object) -> bool:
    """Whether a container date is the epoch the bitexact flags leave behind.

    MP4 counts seconds from 1904-01-01, so "no date" reads back as that date
    rather than as nothing at all. exiftool reports it either way round
    depending on version.
    """
    text = str(value)
    return text.startswith("1904:01:01") or text.startswith("0000")


def container_leaks(props: VideoProperties) -> list[str]:
    """Tag keys ffprobe can still read that the output has no business carrying.

    The concrete form of "ffprobe shows no original metadata": handler_name,
    vendor_id, encoder and creation_time must all be gone, and requiring
    `encoder` to be absent is what proves the bitexact flags did something.
    """
    # No date exemption even when decoyed: the transcode zeroes every container
    # date and the video decoy deliberately writes none, so a creation_time here
    # is one nothing in this pipeline put there.
    allowed = set(ALLOWED_CONTAINER_TAGS)

    leaked: list[str] = []
    for tags in [props.format_tags, *props.stream_tags]:
        for key, value in tags.items():
            name = normalise_tag_key(key)
            if name in allowed:
                continue
            if name in MUXER_CONSTANTS:
                if str(value).strip().lower() in MUXER_CONSTANTS[name]:
                    continue
                leaked.append(f"{name}={value}")
                continue
            if name == "encoder":
                # "Lavc libx264" is what bitexact leaves; "Lavc60.31.102
                # libx264" is what it looks like when the flag did not take.
                lowered = str(value).strip().lower()
                if lowered.startswith(VERSIONLESS_ENCODER) and not any(c.isdigit() for c in lowered.split()[0]):
                    continue
                leaked.append(f"{name}={value}")
                continue
            leaked.append(name)
    return sorted(set(leaked))


def video_derivatives(
    source: Path,
    media_id: str,
    work_dir: Path,
    widths: list[int],
    decoy: dict,
    rng: random.Random,
    *,
    crf: int,
    preset: str,
    max_width: int,
) -> tuple[list[dict], list[str], set[str]]:
    """One sanitised MP4 and the poster derivatives that stand in for it."""
    failures: list[str] = []

    try:
        before = probe_video(source)
    except (ValueError, json.JSONDecodeError) as exc:
        return [], [f"{media_id}: not a video this can read: {exc}"], set()

    expected_width, expected_height = scaled_size(before, max_width)
    out_path = work_dir / f"{media_id}-{expected_width}.mp4"

    result = subprocess.run(
        transcode_args(source, out_path, before, crf=crf, preset=preset, max_width=max_width),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not out_path.exists():
        out_path.unlink(missing_ok=True)
        detail = (result.stderr or "").strip().splitlines()[-1:] or ["no output"]
        return [], [f"{media_id}: the transcode failed: {detail[0]}"], set()

    # The peak is drawn once for the whole item, so the video and its poster
    # claim the same place. (The photo path still draws per derivative; changing
    # behaviour that already ships belongs in its own commit.)
    item_rng = random.Random(rng.randrange(2**32))
    peak = inject_video_decoy(out_path, decoy, item_rng)

    # exiftool rewrites the file to add its atom, which can put moov back behind
    # mdat. Playability outranks a cosmetic tag, so if the remux costs the decoy
    # the decoy is what goes.
    if not moov_before_mdat(out_path):
        remux_faststart(out_path)
        if peak is not None and not any("GPSCoordinates" in k for k in read_tags(out_path)):
            peak = None

    after = probe_video(out_path)
    failures += [f"{out_path.name}: {p}" for p in compare_properties(
        before, after, expected_width=expected_width, expected_height=expected_height
    )]

    leaked = container_leaks(after)
    if leaked:
        failures.append(f"{out_path.name}: container metadata survived: {leaked}")

    tags = read_tags(out_path)
    forbidden = []
    for tag in FORBIDDEN_TAGS:
        found = {k: v for k, v in tags.items() if k.endswith(f":{tag}")}
        if not found:
            continue
        # The coordinates are ours, written on purpose. The dates are the MP4's
        # own zero epoch, which is what "no date" looks like in this container.
        if peak is not None and tag.startswith("GPS"):
            continue
        if tag in ("CreateDate", "ModifyDate") and all(is_zeroed_date(v) for v in found.values()):
            continue
        forbidden.append(tag)
    if forbidden:
        failures.append(f"{out_path.name}: original metadata survived: {forbidden}")

    if out_path.stat().st_size == 0:
        failures.append(f"{out_path.name}: written empty")

    entries = [
        {
            "file": out_path.name,
            "format": "mp4",
            "role": "video",
            "width": after.width,
            "height": after.height,
            "bytes": out_path.stat().st_size,
            "durationSeconds": round(after.duration, 3),
            "hasAudio": after.has_audio,
            "decoyLocation": peak["name"] if peak else None,
        }
    ]

    poster = work_dir / f"{media_id}-poster.png"
    try:
        extract_poster(out_path, poster, after.duration)
    except ValueError as exc:
        return entries, failures + [f"{media_id}: {exc}"], set()

    try:
        poster_entries, poster_failures, skipped = image_derivatives(
            poster,
            media_id,
            work_dir,
            widths,
            decoy,
            item_rng,
            name=f"{media_id}-poster",
            role="poster",
            peak=peak,
        )
    finally:
        # An intermediate, not a derivative: it must not reach the upload.
        poster.unlink(missing_ok=True)

    return entries + poster_entries, failures + poster_failures, skipped


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


@dataclass
class SanitizeResult:
    manifest: dict[str, list[dict]]
    failures: list[str]
    skipped_formats: set[str]


def sanitize(
    source_dir: Path,
    work_dir: Path,
    mapping: dict,
    widths: list[int],
    *,
    crf: int = 20,
    preset: str = "medium",
    max_width: int = 1920,
    decoy: dict | None = None,
    rng: random.Random | None = None,
) -> SanitizeResult:
    """Turns every mapped original into its public derivatives.

    Returns rather than exits, so a caller can inspect the failures without
    catching SystemExit or reading stdout.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    decoy = decoy if decoy is not None else load_decoy()
    rng = rng if rng is not None else random.Random()
    widths = sorted(set(widths), reverse=True)

    manifest: dict[str, list[dict]] = {}
    failures: list[str] = []
    skipped_formats: set[str] = set()

    for media_id, spec in mapping.items():
        # Strict rather than tolerant of a bare filename: the tolerant reading
        # of a missing type is "image", and handing Pillow an mp4 is precisely
        # the failure this whole task exists to remove.
        if not isinstance(spec, dict) or "file" not in spec or "type" not in spec:
            failures.append(f"{media_id}: mapping needs both a file and a type")
            continue

        filename, kind = spec["file"], spec["type"]
        source = source_dir / filename
        if not source.exists():
            failures.append(f"{media_id}: source {filename} not found")
            continue

        if kind == "image":
            try:
                entries, item_failures, skipped = image_derivatives(
                    source, media_id, work_dir, widths, decoy, rng
                )
            except (OSError, ValueError) as exc:
                entries, item_failures, skipped = [], [f"{media_id}: could not open {filename}: {exc}"], set()
        elif kind == "video":
            entries, item_failures, skipped = video_derivatives(
                source, media_id, work_dir, widths, decoy, rng,
                crf=crf, preset=preset, max_width=max_width,
            )
        else:
            entries, item_failures, skipped = [], [f"{media_id}: unknown media type {kind!r}"], set()

        failures += item_failures
        skipped_formats |= skipped
        if entries:
            manifest[media_id] = entries

    (work_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return SanitizeResult(manifest=manifest, failures=failures, skipped_formats=skipped_formats)


def missing_tools(mapping: dict) -> list[str]:
    """Whichever of the tools this run needs are not on the machine."""
    needed = ["exiftool"]
    if any(isinstance(s, dict) and s.get("type") == "video" for s in mapping.values()):
        needed += ["ffmpeg", "ffprobe"]
    return [tool for tool in needed if shutil.which(tool) is None]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir")
    parser.add_argument("work_dir")
    parser.add_argument("mapping")
    parser.add_argument("--widths", default="1600,1200,800,320")
    parser.add_argument("--video-crf", type=int, default=20)
    parser.add_argument("--video-preset", default="medium")
    parser.add_argument("--video-max-width", type=int, default=1920)
    args = parser.parse_args(argv)

    mapping = json.loads(Path(args.mapping).read_text())

    absent = missing_tools(mapping)
    if absent:
        print(f"Missing on this machine: {', '.join(absent)}", file=sys.stderr)
        return 1

    result = sanitize(
        Path(args.source_dir),
        Path(args.work_dir),
        mapping,
        [int(w) for w in args.widths.split(",")],
        crf=args.video_crf,
        preset=args.video_preset,
        max_width=args.video_max_width,
    )

    for entries in result.manifest.values():
        for e in entries:
            decoy_note = f"decoy@{e['decoyLocation']}" if e["decoyLocation"] else "no decoy (format)"
            extra = f" {e['durationSeconds']}s" if "durationSeconds" in e else ""
            print(
                f"{e['file']:36} {e['width']}x{e['height']:<6} "
                f"{e['bytes'] / 1024:7.1f} KiB{extra}  {decoy_note}"
            )

    if result.skipped_formats:
        print(f"\nSkipped, no encoder in this build: {', '.join(sorted(result.skipped_formats))}")

    if result.failures:
        print("\nFAILURES:", file=sys.stderr)
        for f in result.failures:
            print(f"  {f}", file=sys.stderr)
        return 1

    print(f"\n{sum(len(v) for v in result.manifest.values())} derivatives written to {args.work_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
