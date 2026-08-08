"""Fixtures for the media sanitiser's tests.

Every input is built here at test time rather than committed. A checked-in
JPEG with real GPS in it is a privacy problem in a repository whose whole point
is that originals never touch git, and a checked-in MP4 is a binary nobody can
review.

Each builder asserts that the file it produced is *dirty* before handing it
over. Without that, "no GPS survived" passes on a file that never had any --
which is the way a metadata test fails silently rather than loudly.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

REPO_ROOT = Path(__file__).resolve().parents[2]

# Locally the suite skips what the machine cannot do -- this one has no libx264
# and no exiftool. In CI a skip is a hole, so the guards become failures.
REQUIRED = os.environ.get("MEDIA_TESTS_REQUIRED") == "1"


def _have(tool: str) -> bool:
    return shutil.which(tool) is not None


def _have_libx264() -> bool:
    if not _have("ffmpeg"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True)
    return " libx264 " in out.stdout


def _require(condition: bool, what: str) -> None:
    if condition:
        return
    if REQUIRED:
        pytest.fail(f"{what} is required when MEDIA_TESTS_REQUIRED=1 and is not available")
    pytest.skip(f"{what} is not available on this machine")


@pytest.fixture(scope="session")
def needs_exiftool() -> None:
    _require(_have("exiftool"), "exiftool")


@pytest.fixture(scope="session")
def needs_ffmpeg() -> None:
    _require(_have("ffmpeg") and _have("ffprobe"), "ffmpeg and ffprobe")
    # libopenh264 accepts neither -crf nor -preset, so a build without libx264
    # would not fail over -- it would produce something else entirely.
    _require(_have_libx264(), "an ffmpeg built with libx264")


@pytest.fixture(scope="session")
def decoy() -> dict:
    return json.loads((REPO_ROOT / "config" / "media-decoy.json").read_text())


def run(args: list[str]) -> subprocess.CompletedProcess:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError(f"{args[0]} failed: {result.stderr.strip()[-800:]}")
    return result


def probe_tags(path: Path) -> dict:
    """Every container and stream tag ffprobe can read, flattened and lowercased."""
    out = run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)])
    probed = json.loads(out.stdout)
    tags: dict[str, str] = {}
    for source in [probed.get("format", {}), *probed.get("streams", [])]:
        for key, value in (source.get("tags") or {}).items():
            tags[key.lower()] = value
    return tags


def exif_tags(path: Path) -> dict:
    out = run(["exiftool", "-json", "-G", str(path)])
    return json.loads(out.stdout)[0]


@pytest.fixture
def make_photo(tmp_path):
    """A JPEG carrying everything a real camera would put in one."""

    def build(name: str = "photo.jpg", size: tuple[int, int] = (1600, 1067)) -> Path:
        path = tmp_path / "originals" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", size, (140, 90, 60)).save(path, "JPEG", quality=90)
        run([
            "exiftool", "-overwrite_original", "-q",
            "-Make=Canon", "-Model=EOS R6", "-SerialNumber=0123456789",
            "-Software=Darktable 4.6", "-UserComment=shot on the way home",
            "-DateTimeOriginal=2026:04:11 08:14:22",
            "-GPSLatitude=52 22 12.0", "-GPSLatitudeRef=N",
            "-GPSLongitude=4 53 42.0", "-GPSLongitudeRef=E",
            str(path),
        ])

        tags = exif_tags(path)
        assert any(k.endswith(":SerialNumber") for k in tags), "the fixture must start dirty"
        assert any(k.endswith(":GPSLatitude") for k in tags), "the fixture must start dirty"
        return path

    return build


@pytest.fixture
def make_video(tmp_path):
    """A short clip with the metadata a phone writes into one."""

    def build(
        name: str = "clip.mp4",
        *,
        size: tuple[int, int] = (640, 480),
        seconds: float = 1.0,
        audio: bool = True,
        container: str = "mp4",
        location: str | None = None,
        rotation: int | None = None,
    ) -> Path:
        path = tmp_path / "originals" / name
        path.parent.mkdir(parents=True, exist_ok=True)

        args = [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size={size[0]}x{size[1]}:rate=24:duration={seconds}",
        ]
        if audio:
            args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
        args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
        if audio:
            args += ["-c:a", "aac", "-b:a", "64k"]
        args += [
            "-metadata", "make=Apple",
            "-metadata", "model=iPhone 15 Pro",
            "-metadata", "comment=sent from a phone",
            "-metadata", "creation_time=2026-04-11T08:14:22Z",
        ]
        if location is not None:
            args += ["-metadata", f"location={location}"]
        # Without this the MP4 muxer keeps only the handful of keys it has a
        # box for and silently drops make, model and location -- which would
        # leave the fixture clean of exactly what it exists to be dirty with.
        # It is also how a phone writes them: as QuickTime keys.
        args += ["-movflags", "use_metadata_tags", "-f", container, str(path)]
        run(args)

        if rotation is not None:
            # Written as a display matrix on a remux, which is how a phone
            # records it: the pixels stay landscape and a matrix says to turn
            # them. Encoding with the rotation set instead would bake it into
            # the pixels and leave nothing for the sanitiser to have to handle.
            rotated = path.with_name(f"rotated-{path.name}")
            run([
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-display_rotation", str(rotation), "-i", str(path),
                "-map", "0", "-c", "copy", "-map_metadata", "0",
                # Or this pass drops the very tags the fixture exists to carry.
                "-movflags", "use_metadata_tags",
                "-f", container, str(rotated),
            ])
            rotated.replace(path)
            probed = json.loads(run(
                ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)]
            ).stdout)
            matrices = [
                side
                for stream in probed["streams"]
                for side in (stream.get("side_data_list") or [])
                if "rotation" in side
            ]
            assert matrices, "the rotated fixture must actually carry a display matrix"

        tags = probe_tags(path)
        assert "model" in tags or "com.apple.quicktime.model" in tags, "the fixture must start dirty"
        assert "encoder" in tags or "handler_name" in tags, "the fixture must start dirty"
        if location is not None:
            assert any("location" in k for k in tags), "the location fixture must carry a location"
        return path

    return build


@pytest.fixture
def work_dir(tmp_path) -> Path:
    path = tmp_path / "public"
    path.mkdir(parents=True, exist_ok=True)
    return path
