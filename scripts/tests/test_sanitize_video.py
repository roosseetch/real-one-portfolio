"""The video path: the matrix the task asks for, plus what it implies.

The acceptance criteria are literally "ffprobe shows no original metadata,
duration and audio are preserved, a poster is generated", so each of those is
one assertion against a fixture that demonstrably started out the other way.
"""
import random
from pathlib import Path

import pytest

import sanitize_media
from conftest import exif_tags, probe_tags

pytestmark = pytest.mark.usefixtures("needs_exiftool", "needs_ffmpeg")

# Everything the fixtures put into a source, in the form the output must not
# contain any of. Checking values rather than re-listing the allowed keys keeps
# this test independent of the sanitiser's own allowlist -- a list that grew
# wrong would otherwise be checked against a copy of itself.
SOURCE_TRACES = ["Apple", "iPhone", "sent from a phone", "2026-04-11", "52.36", "4.90"]


def assert_no_source_traces(path: Path) -> None:
    tags = probe_tags(path)
    printed = " ".join(f"{k}={v}" for k, v in tags.items())
    for trace in SOURCE_TRACES:
        assert trace not in printed, f"{trace!r} survived into {path.name}: {printed}"

    # The three the MP4 muxer always writes. They cannot be removed, only made
    # to say nothing, so what matters is that they say the generic thing rather
    # than the camera's or the encoder's version.
    assert tags.get("handler_name", "VideoHandler") in ("VideoHandler", "SoundHandler", "")
    assert tags.get("vendor_id", "[0][0][0][0]") in ("[0][0][0][0]", "")
    encoder = tags.get("encoder", "Lavc")
    assert not any(c.isdigit() for c in encoder.split()[0]), f"a versioned encoder survived: {encoder}"


def sanitize(work_dir: Path, source: Path, media_id="media0", widths=(1600, 800, 320), **kw):
    return sanitize_media.sanitize(
        source.parent,
        work_dir,
        {media_id: {"file": source.name, "type": "video"}},
        list(widths),
        rng=random.Random(11),
        preset="ultrafast",
        **kw,
    )


def video_entry(result, media_id="media0"):
    return next(e for e in result.manifest[media_id] if e["role"] == "video")


def poster_entries(result, media_id="media0"):
    return [e for e in result.manifest[media_id] if e["role"] == "poster"]


def test_mp4_publishes_one_video_and_a_poster_set(make_video, work_dir):
    result = sanitize(work_dir, make_video(name="clip.mp4"))

    assert result.failures == []
    video = video_entry(result)
    assert video["file"].endswith(".mp4")
    assert video["hasAudio"] is True
    posters = poster_entries(result)
    assert {p["format"] for p in posters} >= {"webp"}
    assert sorted({p["width"] for p in posters if p["format"] == "webp"}) == [320, 640]


def test_no_original_container_metadata_survives(make_video, work_dir):
    source = make_video(name="clip.mp4")
    before = probe_tags(source)
    assert "encoder" in before or "handler_name" in before

    result = sanitize(work_dir, source)

    assert result.failures == []
    assert_no_source_traces(work_dir / video_entry(result)["file"])


def test_a_mov_becomes_a_clean_mp4(make_video, work_dir):
    result = sanitize(work_dir, make_video(name="clip.mov", container="mov"))

    assert result.failures == []
    output = work_dir / video_entry(result)["file"]
    assert_no_source_traces(output)
    # Whatever it arrived as, it leaves as an MP4: one container downstream,
    # rather than a second one for the site to have to reason about.
    assert sanitize_media.probe_video(output).video_codec == "h264"


def test_a_gps_tagged_clip_carries_the_decoy_or_nothing(make_video, work_dir, decoy):
    source = make_video(name="located.mp4", location="+52.3676+004.9041/")
    result = sanitize(work_dir, source)

    assert result.failures == []
    entry = video_entry(result)
    tags = probe_tags(work_dir / entry["file"])
    written = " ".join(v for k, v in tags.items() if "location" in k)

    # The source was in Amsterdam. Whatever the output says, it must not say that.
    assert "52.36" not in written and "4.90" not in written

    if entry["decoyLocation"] is None:
        # Not injectable in this exiftool build: then there must be no location
        # at all, not a half-written one.
        assert written == ""
    else:
        peak = next(p for p in decoy["gpsCandidates"] if p["name"] == entry["decoyLocation"])
        assert f"{peak['lat']:.2f}"[:4] in written
        # The poster claims the same place as the video it stands for.
        assert {p["decoyLocation"] for p in poster_entries(result)} == {entry["decoyLocation"]}


def test_no_date_is_claimed_on_a_video_because_the_container_cannot_hold_ours(make_video, work_dir):
    result = sanitize(work_dir, make_video(name="clip.mp4"))

    assert result.failures == []
    tags = probe_tags(work_dir / video_entry(result)["file"])
    # The configured decoy year is 2117, and an MP4 counts seconds from 1904 in
    # 32 bits -- it runs out in 2040. Writing it anyway does not fail, it wraps,
    # and the file comes out claiming 1981. Nothing is the honest answer.
    assert "creation_time" not in tags
    assert "1981" not in " ".join(tags.values())


def test_the_poster_still_carries_the_2117_stamp_that_exif_can_hold(make_video, work_dir, decoy):
    result = sanitize(work_dir, make_video(name="clip.mp4"))

    poster = work_dir / next(p["file"] for p in poster_entries(result) if p["format"] == "webp")
    tags = exif_tags(poster)
    taken = next((v for k, v in tags.items() if k.endswith(":DateTimeOriginal")), "")
    assert str(taken).startswith(decoy["dateTimeOriginal"]["date"])


def test_duration_survives_the_transcode(make_video, work_dir):
    result = sanitize(work_dir, make_video(seconds=2.0))

    assert result.failures == []
    assert abs(video_entry(result)["durationSeconds"] - 2.0) <= 0.15


def test_a_silent_clip_stays_silent_rather_than_gaining_an_empty_track(make_video, work_dir):
    source = make_video(name="silent.mp4", audio=False)
    result = sanitize(work_dir, source)

    assert result.failures == []
    entry = video_entry(result)
    assert entry["hasAudio"] is False
    assert sanitize_media.probe_video(work_dir / entry["file"]).audio_codec is None


def test_the_command_line_says_an_for_a_silent_source(make_video, work_dir):
    props = sanitize_media.probe_video(make_video(name="silent.mp4", audio=False))
    args = sanitize_media.transcode_args(
        Path("in.mp4"), Path("out.mp4"), props, crf=20, preset="medium", max_width=1920
    )

    assert "-an" in args
    assert "-c:a" not in args


def test_a_source_within_the_cap_is_not_resized_at_all(make_video, work_dir):
    props = sanitize_media.probe_video(make_video(size=(640, 480)))
    args = sanitize_media.transcode_args(
        Path("in.mp4"), Path("out.mp4"), props, crf=20, preset="medium", max_width=1920
    )

    # "Avoid resize unless required", taken literally: no filter graph at all,
    # so no chroma resampling on a clip that did not need it.
    assert "-vf" not in args


def test_an_oversized_source_is_scaled_to_the_cap(make_video, work_dir):
    result = sanitize(work_dir, make_video(size=(3840, 2160), seconds=0.5), max_width=1920)

    assert result.failures == []
    entry = video_entry(result)
    assert (entry["width"], entry["height"]) == (1920, 1080)


def test_a_rotated_source_comes_out_upright(make_video, work_dir):
    result = sanitize(work_dir, make_video(size=(640, 480), rotation=90))

    assert result.failures == []
    entry = video_entry(result)
    # Portrait display dimensions, and no matrix left for the site to apply.
    assert (entry["width"], entry["height"]) == (480, 640)
    assert sanitize_media.probe_video(work_dir / entry["file"]).rotation == 0


def test_the_output_starts_playing_before_it_finishes_downloading(make_video, work_dir):
    result = sanitize(work_dir, make_video())

    assert sanitize_media.moov_before_mdat(work_dir / video_entry(result)["file"])


def test_the_poster_is_a_picture_with_no_identifying_metadata(make_video, work_dir):
    result = sanitize(work_dir, make_video())

    poster = work_dir / next(p["file"] for p in poster_entries(result) if p["format"] == "webp")
    tags = exif_tags(poster)
    for forbidden in ("SerialNumber", "Software", "UserComment", "HostComputer"):
        assert not any(k.endswith(f":{forbidden}") for k in tags)


def test_the_intermediate_poster_frame_is_not_left_behind(make_video, work_dir):
    sanitize(work_dir, make_video())

    # A PNG in here would be uploaded as a derivative nothing references.
    assert list(work_dir.glob("*.png")) == []


def test_a_file_that_is_not_a_video_fails_without_writing_one(make_video, work_dir, tmp_path):
    source = tmp_path / "originals" / "clip.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("this is not a video")

    result = sanitize(work_dir, source)

    assert result.manifest == {}
    assert any("media0" in f for f in result.failures)
    assert list(work_dir.glob("*.mp4")) == []


def test_a_jpeg_named_like_a_video_fails_the_same_way(work_dir, tmp_path):
    from PIL import Image

    source = tmp_path / "originals" / "clip.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), (10, 20, 30)).save(source, "JPEG")

    result = sanitize(work_dir, source)

    assert result.manifest == {}
    assert list(work_dir.glob("*.mp4")) == []


def test_an_image_and_a_video_travel_in_one_manifest(make_video, make_photo, work_dir, tmp_path):
    photo = make_photo(name="photo.jpg", size=(800, 600))
    clip = make_video(name="clip.mp4")

    result = sanitize_media.sanitize(
        clip.parent,
        work_dir,
        {"media0": {"file": photo.name, "type": "image"}, "media1": {"file": clip.name, "type": "video"}},
        [800, 320],
        rng=random.Random(11),
        preset="ultrafast",
    )

    assert result.failures == []
    assert {e["role"] for e in result.manifest["media0"]} == {"image"}
    assert {e["role"] for e in result.manifest["media1"]} == {"video", "poster"}
