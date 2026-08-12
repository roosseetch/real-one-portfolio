import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { activityPrefix, deletePublishedItem, deletePublishedMedia, locateMedia } from "./published";

const ACTIVITY = "abc123def456ghjk";
const MEDIA = "med123def456ghjk";
const BASE = "https://media.example";

let media: FakeBucket;

beforeEach(() => {
  media = createFakeBucket();
});

/** n objects under one activity, as the pipeline would have uploaded them. */
function fill(activityId: string, count: number) {
  for (let i = 0; i < count; i++) {
    media.objects.set(`${activityPrefix(activityId)}media0-${i}.webp`, "bytes");
  }
}

describe("deletePublishedMedia", () => {
  it("removes one activity's objects and nothing else", async () => {
    fill("abc123def456ghjk", 3);
    media.objects.set("media/activity-zzz123def456ghjk/other-800.webp", "someone else's");

    expect(await deletePublishedMedia(media.bucket, "abc123def456ghjk")).toBe(3);
    expect([...media.objects.keys()]).toEqual(["media/activity-zzz123def456ghjk/other-800.webp"]);
  });

  it("is not confused by an activity id that is a prefix of another", async () => {
    // R2 lists by prefix, and "activity-abc123def456ghjk/" cannot match
    // "activity-abc123def456ghjkmn/" only because of the trailing slash.
    fill("abc123def456ghjk", 1);
    fill("abc123def456ghjkmn", 2);

    await deletePublishedMedia(media.bucket, "abc123def456ghjk");

    expect([...media.objects.keys()].every((key) => key.includes("ghjkmn"))).toBe(true);
    expect(media.objects.size).toBe(2);
  });

  it("follows the cursor past a full page", async () => {
    // The delete is scoped by a list, so a fake that returned everything in one
    // page would leave the paging untested and a large album half-removed.
    fill("abc123def456ghjk", 2400);

    expect(await deletePublishedMedia(media.bucket, "abc123def456ghjk")).toBe(2400);
    expect(media.objects.size).toBe(0);
  });

  it("does nothing at all for an id that is not one of ours", async () => {
    // The id is minted by the Worker, never taken from an author or a callback —
    // but it is pasted into an object prefix, and a prefix with a slash in it
    // names a different activity's media.
    fill("abc123def456ghjk", 2);
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (const bad of ["", "../..", "abc/def/ghij", "ABC123DEF456GHJK", "short"]) {
      expect(await deletePublishedMedia(media.bucket, bad)).toBe(0);
    }
    expect(media.objects.size).toBe(2);
  });

  it("reports what it managed rather than throwing", async () => {
    // This runs while a draft is being cancelled. A cancellation that fails
    // because a delete did would leave the author with a live preview for
    // something they have already declined.
    fill("abc123def456ghjk", 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...media.bucket,
      list: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;

    expect(await deletePublishedMedia(broken, "abc123def456ghjk")).toBe(0);
  });
});

describe("locateMedia", () => {
  /**
   * A record stores URLs and nothing else, so this is the only route from "the
   * author pointed at this picture" to the objects behind it.
   */
  it("reads both ids back out of every shape the pipeline produces", () => {
    const cases = [
      `${BASE}/media/activity-${ACTIVITY}/${MEDIA}-1600.webp`,
      `${BASE}/media/activity-${ACTIVITY}/${MEDIA}-400.avif`,
      `${BASE}/media/activity-${ACTIVITY}/${MEDIA}-1280.mp4`,
      // A video's poster carries an infix, and the id must still be the id.
      `${BASE}/media/activity-${ACTIVITY}/${MEDIA}-poster-800.webp`,
    ];

    for (const url of cases) {
      expect(locateMedia(url)).toEqual({ activityId: ACTIVITY, mediaId: MEDIA });
    }
  });

  it("reads a URL from any host, because the host is the caller's question", () => {
    expect(locateMedia(`https://elsewhere.example/media/activity-${ACTIVITY}/${MEDIA}-800.webp`)).toEqual({
      activityId: ACTIVITY,
      mediaId: MEDIA,
    });
  });

  /**
   * Both halves are pasted into an object prefix. An id with a slash or a dot in
   * it would reach past the activity it claims to be.
   */
  it("refuses anything that is not two ids in the layout we write", () => {
    const bad = [
      "not a url at all",
      `${BASE}/media/activity-${ACTIVITY}/`,
      // No hyphen, so nothing separates the id from a width.
      `${BASE}/media/activity-${ACTIVITY}/${MEDIA}.webp`,
      `${BASE}/media/activity-../${MEDIA}-800.webp`,
      `${BASE}/media/activity-${ACTIVITY}/AB-800.webp`,
      `${BASE}/media/${ACTIVITY}/${MEDIA}-800.webp`,
      `${BASE}/originals/${ACTIVITY}/${MEDIA}-800.webp`,
    ];

    for (const url of bad) expect(locateMedia(url)).toBeNull();
  });
});

describe("deletePublishedItem", () => {
  /** One item's whole set, as the sanitiser names it. */
  function fillItem(activityId: string, mediaId: string) {
    for (const name of [
      `${mediaId}-400.webp`,
      `${mediaId}-800.webp`,
      `${mediaId}-1600.avif`,
      `${mediaId}-poster-400.webp`,
    ]) {
      media.objects.set(`${activityPrefix(activityId)}${name}`, "bytes");
    }
  }

  it("removes every derivative of one item and leaves its neighbours alone", async () => {
    fillItem(ACTIVITY, MEDIA);
    fillItem(ACTIVITY, "oth123def456ghjk");

    expect(await deletePublishedItem(media.bucket, { activityId: ACTIVITY, mediaId: MEDIA })).toBe(4);
    expect([...media.objects.keys()].every((key) => key.includes("oth123def456ghjk"))).toBe(true);
    expect(media.objects.size).toBe(4);
  });

  it("is not confused by a media id that is a prefix of another", async () => {
    // The trailing hyphen is what separates them, and the media id alphabet has
    // no hyphen in it — which is the whole reason that works.
    fillItem(ACTIVITY, MEDIA);
    fillItem(ACTIVITY, `${MEDIA}extra`);

    await deletePublishedItem(media.bucket, { activityId: ACTIVITY, mediaId: MEDIA });

    expect([...media.objects.keys()].every((key) => key.includes(`${MEDIA}extra`))).toBe(true);
  });

  it("counts nothing rather than failing when the files are already gone", async () => {
    expect(await deletePublishedItem(media.bucket, { activityId: ACTIVITY, mediaId: MEDIA })).toBe(0);
  });

  it("does nothing at all for ids that are not ours", async () => {
    fillItem(ACTIVITY, MEDIA);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await deletePublishedItem(media.bucket, { activityId: "../..", mediaId: MEDIA })).toBe(0);
    expect(await deletePublishedItem(media.bucket, { activityId: ACTIVITY, mediaId: "a/b" })).toBe(0);
    expect(media.objects.size).toBe(4);
  });
});
