import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { loadDraft, saveDraft } from "../drafts/store";
import { DRAFT_SCHEMA_VERSION, type Draft, type ProcessedMedia } from "../drafts/types";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { attachProcessedMedia } from "./attach-record";

let storage: FakeBucket;
let content: FakeBucket;
let calls: Array<{ method: string; body: Record<string, unknown> }>;

const CHAT = 99;
const DRAFT_ID = "dra123def456ghjk";
const BASE = "https://media.example/media/activity-act123def456ghjk";

function env() {
  return {
    PRIVATE_BUCKET: storage.bucket,
    CONTENT_BUCKET: content.bucket,
    TELEGRAM_BOT_TOKEN: "test-token",
    SITE_BASE_URL: "https://site.example",
  };
}

function draft(recordId: string | null): Draft {
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    draftId: DRAFT_ID,
    state: "processing",
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
    source: { chatId: CHAT, senderId: 42, messageId: 1 },
    activityId: "act123def456ghjk",
    mediaGroupId: null,
    originals: [],
    mediaDeclined: false,
    input: { text: "" },
    record: null,
    attachment: { recordId },
    preview: null,
    published: null,
    job: { jobToken: "job-token", dispatchedAt: "2026-08-12T09:00:00.000Z" },
    processed: null,
  };
}

function processed(mediaId: string, type: "image" | "video" = "image"): ProcessedMedia {
  return type === "video"
    ? {
        sourceId: mediaId,
        type,
        src: `${BASE}/${mediaId}-1280.mp4`,
        poster: `${BASE}/${mediaId}-poster-1600.webp`,
        thumbnail: `${BASE}/${mediaId}-poster-400.webp`,
        visibleChanges: [],
      }
    : {
        sourceId: mediaId,
        type,
        src: `${BASE}/${mediaId}-1600.webp`,
        thumbnail: `${BASE}/${mediaId}-400.webp`,
        visibleChanges: [],
      };
}

function publish(record: PublicRecord): void {
  const manifest: Manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    recordsPerFile: 10,
    totalRecords: 1,
    records: [{ id: "chunk0", sha256: "x", count: 1 }],
    latest: "chunk0",
  };

  content.objects.set(chunkKey("chunk0"), JSON.stringify([record]));
  content.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
}

function record(id: string, title: string, media: PublicRecord["media"] = []): PublicRecord {
  return {
    id,
    title,
    summary: null,
    body: null,
    eventDate: null,
    publishedAt: "2026-08-10T09:00:00.000Z",
    tags: [],
    media,
  };
}

function live(): PublicRecord {
  const manifest = JSON.parse(content.objects.get(MANIFEST_KEY) as string) as Manifest;
  return (JSON.parse(content.objects.get(chunkKey(manifest.records[0].id)) as string) as PublicRecord[])[0];
}

function sent(): string[] {
  return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
}

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  calls = [];

  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const method = new URL(String(url)).pathname.split("/").pop() ?? "";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachProcessedMedia", () => {
  it("appends to what the activity already has, in the site's own shape", async () => {
    publish(record("aaaaaaaaaaaaaaaa", "A morning run", [
      { type: "image", src: `${BASE}/old111def456ghjk-1600.webp`, alt: null, caption: null },
    ]));
    await saveDraft(storage.bucket, draft("aaaaaaaaaaaaaaaa"));

    const result = await attachProcessedMedia(
      env(),
      draft("aaaaaaaaaaaaaaaa"),
      [processed("new111def456ghjk"), processed("new222def456ghjk", "video")],
    );

    expect(result).toEqual({
      status: "attached",
      url: "https://site.example/activities/?v=a-morning-run",
    });

    const media = live().media;
    expect(media).toHaveLength(3);
    // The one that was already there keeps its place.
    expect(media[0].src).toContain("old111def456ghjk");
    expect(media[1]).toEqual({
      type: "image",
      src: `${BASE}/new111def456ghjk-1600.webp`,
      thumbnail: `${BASE}/new111def456ghjk-400.webp`,
      alt: null,
      caption: null,
    });
    expect(media[2].poster).toBe(`${BASE}/new222def456ghjk-poster-1600.webp`);
  });

  it("adds to an activity that had no media at all", async () => {
    publish(record("aaaaaaaaaaaaaaaa", "A note"));
    await saveDraft(storage.bucket, draft("aaaaaaaaaaaaaaaa"));

    await attachProcessedMedia(env(), draft("aaaaaaaaaaaaaaaa"), [processed("new111def456ghjk")]);

    expect(live().media).toHaveLength(1);
  });

  it("retires the draft so a repeat cannot add the same files twice", async () => {
    publish(record("aaaaaaaaaaaaaaaa", "A morning run"));
    await saveDraft(storage.bucket, draft("aaaaaaaaaaaaaaaa"));

    await attachProcessedMedia(env(), draft("aaaaaaaaaaaaaaaa"), [processed("new111def456ghjk")]);

    const stored = await loadDraft(storage.bucket, DRAFT_ID);
    expect(stored?.state).toBe("published");
    expect(stored?.published).toEqual({
      recordId: "aaaaaaaaaaaaaaaa",
      url: "https://site.example/activities/?v=a-morning-run",
    });
  });

  /**
   * A callback delivered twice carries the same URLs. Without the check on
   * `src`, the second delivery would put the same picture on the page again.
   */
  it("does not add a file the activity already shows", async () => {
    publish(record("aaaaaaaaaaaaaaaa", "A morning run"));
    await saveDraft(storage.bucket, draft("aaaaaaaaaaaaaaaa"));

    await attachProcessedMedia(env(), draft("aaaaaaaaaaaaaaaa"), [processed("new111def456ghjk")]);
    const afterFirst = content.objects.size;

    await attachProcessedMedia(env(), draft("aaaaaaaaaaaaaaaa"), [processed("new111def456ghjk")]);

    expect(live().media).toHaveLength(1);
    // No chunk was rewritten for a change that was not one.
    expect(content.objects.size).toBe(afterFirst);
  });

  it("tells the author what landed, and where", async () => {
    publish(record("aaaaaaaaaaaaaaaa", "A morning run"));
    await saveDraft(storage.bucket, draft("aaaaaaaaaaaaaaaa"));

    await attachProcessedMedia(env(), draft("aaaaaaaaaaaaaaaa"), [
      processed("new111def456ghjk"),
      processed("new222def456ghjk"),
    ]);

    expect(sent().at(-1)).toBe(
      'Added the 2 files to "A morning run". https://site.example/activities/?v=a-morning-run',
    );
  });

  it("does nothing at all when the draft names no activity", async () => {
    publish(record("aaaaaaaaaaaaaaaa", "A morning run"));

    expect(await attachProcessedMedia(env(), draft(null), [processed("new111def456ghjk")])).toEqual({
      status: "failed",
    });
    expect(live().media).toHaveLength(0);
  });

  it("leaves the draft where it is when the activity has gone", async () => {
    publish(record("aaaaaaaaaaaaaaaa", "A morning run"));
    await saveDraft(storage.bucket, draft("zzzzzzzzzzzzzzzz"));

    const result = await attachProcessedMedia(env(), draft("zzzzzzzzzzzzzzzz"), [
      processed("new111def456ghjk"),
    ]);

    expect(result).toEqual({ status: "failed" });
    // Still `processing`, which is the state the retry flow works from.
    expect((await loadDraft(storage.bucket, DRAFT_ID))?.state).toBe("processing");
  });
});
