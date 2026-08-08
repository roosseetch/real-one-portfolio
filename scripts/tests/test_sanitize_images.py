"""The photo path, which shipped before it had any test at all.

Nothing here is new behaviour. It is the guard that lets the video branch be
added to this file without anyone having to take on trust that the pictures
still come out the same.
"""
import random
from pathlib import Path

import pytest

import sanitize_media
from conftest import exif_tags

pytestmark = pytest.mark.usefixtures("needs_exiftool")


def sanitize(work_dir: Path, source: Path, media_id="media0", widths=(1600, 1200, 800, 320), **kw):
    return sanitize_media.sanitize(
        source.parent,
        work_dir,
        {media_id: {"file": source.name, "type": "image"}},
        list(widths),
        rng=random.Random(7),
        **kw,
    )


def test_strips_everything_identifying(make_photo, work_dir):
    result = sanitize(work_dir, make_photo())

    assert result.failures == []
    for entry in result.manifest["media0"]:
        tags = exif_tags(work_dir / entry["file"])
        for forbidden in ("SerialNumber", "OwnerName", "Artist", "Software", "UserComment", "HostComputer"):
            assert not any(k.endswith(f":{forbidden}") for k in tags), f"{entry['file']} kept {forbidden}"


def test_writes_a_decoy_that_matches_the_configured_peaks(make_photo, work_dir, decoy):
    result = sanitize(work_dir, make_photo())

    peaks = {p["name"]: p for p in decoy["gpsCandidates"]}
    for entry in result.manifest["media0"]:
        assert entry["decoyLocation"] in peaks
        tags = exif_tags(work_dir / entry["file"])
        written = next(v for k, v in tags.items() if k.endswith(":GPSLatitude"))
        expected = peaks[entry["decoyLocation"]]["lat"]
        # exiftool prints "52 deg 22' 12.00\" N"; the degrees are enough to tell
        # one Alpine peak from another.
        assert str(int(abs(expected))) in str(written)
        assert decoy["camera"]["make"] in str(next(v for k, v in tags.items() if k.endswith(":Make")))


def test_emits_every_requested_width_at_or_below_the_source(make_photo, work_dir):
    result = sanitize(work_dir, make_photo(size=(1600, 1067)))

    widths = sorted({e["width"] for e in result.manifest["media0"] if e["format"] == "webp"})
    assert widths == [320, 800, 1200, 1600]


def test_never_upscales_and_writes_one_file_per_clamped_width(make_photo, work_dir):
    result = sanitize(work_dir, make_photo(size=(400, 300)))

    webp = [e for e in result.manifest["media0"] if e["format"] == "webp"]
    # 1600, 1200 and 800 all clamp to 400; 320 stands on its own.
    assert sorted(e["width"] for e in webp) == [320, 400]
    assert result.failures == []


def test_keeps_the_aspect_ratio(make_photo, work_dir):
    result = sanitize(work_dir, make_photo(size=(1600, 900)))

    for entry in result.manifest["media0"]:
        assert abs(entry["width"] / entry["height"] - 1600 / 900) < 0.01


def test_composites_transparency_onto_white_rather_than_black(work_dir, tmp_path):
    from PIL import Image

    source = tmp_path / "originals" / "logo.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", (400, 400), (0, 0, 0, 0)).save(source, "PNG")

    result = sanitize(work_dir, source, widths=(400,))

    assert result.failures == []
    written = next(work_dir.glob("media0-400.webp"))
    with Image.open(written) as out:
        assert out.convert("RGB").getpixel((10, 10)) == (255, 255, 255)


def test_marks_every_entry_with_its_role(make_photo, work_dir):
    result = sanitize(work_dir, make_photo(), widths=(320,))

    assert {e["role"] for e in result.manifest["media0"]} == {"image"}


def test_reports_a_source_that_is_not_there(work_dir, tmp_path):
    (tmp_path / "originals").mkdir(parents=True, exist_ok=True)
    result = sanitize_media.sanitize(
        tmp_path / "originals",
        work_dir,
        {"media0": {"file": "gone.jpg", "type": "image"}},
        [320],
        rng=random.Random(7),
    )

    assert result.manifest == {}
    assert any("media0" in f and "not found" in f for f in result.failures)


def test_reports_a_file_that_is_not_a_picture(work_dir, tmp_path):
    source = tmp_path / "originals" / "invoice.jpg"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("this is not a JPEG")

    result = sanitize(work_dir, source)

    assert result.manifest == {}
    assert any("media0" in f for f in result.failures)


def test_a_mapping_without_a_type_is_refused_rather_than_assumed(work_dir, tmp_path, make_photo):
    photo = make_photo()
    result = sanitize_media.sanitize(
        photo.parent, work_dir, {"media0": photo.name}, [320], rng=random.Random(7)
    )

    # The tolerant reading of a missing type is "image", and that is how an mp4
    # ends up in front of Pillow.
    assert result.manifest == {}
    assert any("needs both a file and a type" in f for f in result.failures)


def test_main_returns_nonzero_when_a_source_fails(work_dir, tmp_path, capsys):
    source = tmp_path / "originals" / "invoice.jpg"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("this is not a JPEG")
    mapping = tmp_path / "mapping.json"
    mapping.write_text('{"media0": {"file": "invoice.jpg", "type": "image"}}')

    code = sanitize_media.main([str(source.parent), str(work_dir), str(mapping), "--widths", "320"])

    assert code == 1
    assert "FAILURES" in capsys.readouterr().err
