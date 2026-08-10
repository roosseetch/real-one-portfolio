import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { activityPrefix, deletePublishedMedia } from "./published";

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
