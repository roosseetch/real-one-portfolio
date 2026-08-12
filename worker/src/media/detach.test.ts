import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicMedia, PublicRecord } from "../content/records";
import { takePending } from "../drafts/pending";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramCallbackQuery } from "../telegram/types";
import { handleDetachCallback, isDetachCallback, promptForRemoval } from "./detach";
import { activityPrefix } from "./published";

let storage: FakeBucket;
let content: FakeBucket;
let media: FakeBucket;
let calls: Array<{ method: string; body: Record<string, unknown> }>;

const CHAT = 99;
const ACTIVITY = "act123def456ghjk";
const FIRST = "med111def456ghjk";
const SECOND = "med222def456ghjk";
const BASE = "https://media.example";

function env() {
  return {
    PRIVATE_BUCKET: storage.bucket,
    CONTENT_BUCKET: content.bucket,
    MEDIA_BUCKET: media.bucket,
    TELEGRAM_BOT_TOKEN: "test-token",
    SITE_BASE_URL: "https://site.example",
  };
}

function item(mediaId: string, type: "image" | "video" = "image"): PublicMedia {
  return type === "video"
    ? {
        type,
        src: `${BASE}/media/activity-${ACTIVITY}/${mediaId}-1280.mp4`,
        poster: `${BASE}/media/activity-${ACTIVITY}/${mediaId}-poster-1600.webp`,
        thumbnail: `${BASE}/media/activity-${ACTIVITY}/${mediaId}-poster-400.webp`,
        alt: null,
        caption: null,
      }
    : {
        type,
        src: `${BASE}/media/activity-${ACTIVITY}/${mediaId}-1600.webp`,
        thumbnail: `${BASE}/media/activity-${ACTIVITY}/${mediaId}-400.webp`,
        alt: null,
        caption: null,
      };
}

function record(id: string, title: string, mediaItems: PublicMedia[] = []): PublicRecord {
  return {
    id,
    title,
    summary: null,
    body: null,
    eventDate: null,
    publishedAt: "2026-08-10T09:00:00.000Z",
    tags: [],
    media: mediaItems,
  };
}

function publish(records: PublicRecord[]): void {
  const manifest: Manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    recordsPerFile: 10,
    totalRecords: records.length,
    records: records.length === 0 ? [] : [{ id: "chunk0", sha256: "x", count: records.length }],
    latest: records.length === 0 ? null : "chunk0",
  };

  content.objects.set(chunkKey("chunk0"), JSON.stringify(records));
  content.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
}

/** One item's whole derivative set in the media bucket. */
function fill(mediaId: string): void {
  for (const name of [`${mediaId}-400.webp`, `${mediaId}-1600.webp`, `${mediaId}-1600.avif`]) {
    media.objects.set(`${activityPrefix(ACTIVITY)}${name}`, "bytes");
  }
}

function press(data: string): TelegramCallbackQuery {
  return {
    id: "cb-1",
    from: { id: 42 },
    data,
    message: { message_id: 7, date: 0, chat: { id: CHAT, type: "private" } },
  };
}

function sent(): string[] {
  return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
}

function photos(): Array<{ photo: string; caption: string; keyboard: string[] }> {
  return calls
    .filter((c) => c.method === "sendPhoto")
    .map((c) => ({
      photo: String(c.body.photo),
      caption: String(c.body.caption),
      keyboard: (
        (c.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> })
          ?.inline_keyboard ?? []
      )
        .flat()
        .map((button) => button.callback_data),
    }));
}

function liveRecords(): PublicRecord[] {
  const manifest = JSON.parse(content.objects.get(MANIFEST_KEY) as string) as Manifest;
  return JSON.parse(content.objects.get(chunkKey(manifest.records[0].id)) as string) as PublicRecord[];
}

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  media = createFakeBucket();
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

describe("isDetachCallback", () => {
  it("claims its own namespace and nothing else", () => {
    expect(isDetachCallback("rm:p:record")).toBe(true);
    expect(isDetachCallback("rm:x")).toBe(true);
    expect(isDetachCallback("p:draft123:token123")).toBe(false);
    expect(isDetachCallback("l:p:record")).toBe(false);
    expect(isDetachCallback("am:p:d:t:r")).toBe(false);
    expect(isDetachCallback(undefined)).toBe(false);
  });
});

describe("promptForRemoval", () => {
  it("offers the newest activities and says which have nothing on them", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", [item(FIRST)]), record("bbbbbbbbbbbbbbbb", "A note")]);

    await promptForRemoval(env(), CHAT);

    const keyboard = (
      calls.at(-1)?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
    ).inline_keyboard;

    expect(keyboard[0][0].text).toBe("Latest — A note (no media)");
    expect(keyboard[0][0].callback_data).toBe("rm:p:bbbbbbbbbbbbbbbb");
    expect(keyboard[1][0].text).toBe("A morning run");
  });

  it("says so when nothing has been published", async () => {
    publish([]);
    await promptForRemoval(env(), CHAT);
    expect(sent().at(-1)).toContain("Nothing has been published yet");
  });
});

describe("choosing an activity", () => {
  it("shows every item as its own picture with its own button", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", [item(FIRST), item(SECOND, "video")])]);

    await handleDetachCallback(press("rm:p:aaaaaaaaaaaaaaaa"), env());

    const shown = photos();
    expect(shown).toHaveLength(2);

    // The thumbnail, not the full-size file: it is the smallest derivative, and
    // for a video it is the poster frame.
    expect(shown[0].photo).toBe(`${BASE}/media/activity-${ACTIVITY}/${FIRST}-400.webp`);
    expect(shown[0].caption).toContain("Photo 1 of 2");
    expect(shown[0].keyboard).toEqual([`rm:d:aaaaaaaaaaaaaaaa:${FIRST}`]);

    expect(shown[1].photo).toBe(`${BASE}/media/activity-${ACTIVITY}/${SECOND}-poster-400.webp`);
    expect(shown[1].caption).toContain("Video 2 of 2");
    // The real file, because a thumbnail is not enough to be sure which clip it is.
    expect(shown[1].caption).toContain(`${SECOND}-1280.mp4`);
  });

  it("says so when the activity has nothing on it", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A note")]);

    await handleDetachCallback(press("rm:p:aaaaaaaaaaaaaaaa"), env());

    expect(sent().at(-1)).toContain("no photos or videos");
    expect(photos()).toHaveLength(0);
  });

  it("shows an item whose URL it cannot read, without a button under it", async () => {
    publish([
      record("aaaaaaaaaaaaaaaa", "A morning run", [
        { type: "image", src: "https://elsewhere.example/some/other/layout.jpg", alt: null, caption: null },
      ]),
    ]);

    await handleDetachCallback(press("rm:p:aaaaaaaaaaaaaaaa"), env());

    expect(photos()).toHaveLength(0);
    expect(sent().at(-2)).toContain("cannot work out which files");
  });

  it("takes a pasted link instead of a button", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", [item(FIRST)])]);

    await handleDetachCallback(press("rm:o"), env());
    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "detach-target" });
  });
});

describe("removing an item", () => {
  beforeEach(() => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", [item(FIRST), item(SECOND)])]);
    fill(FIRST);
    fill(SECOND);
  });

  /** The whole point of the second question: this is the one destructive thing here. */
  it("asks before anything is touched", async () => {
    await handleDetachCallback(press(`rm:d:aaaaaaaaaaaaaaaa:${FIRST}`), env());

    expect(sent().at(-1)).toContain('Remove photo 1 of 2 from "A morning run"?');
    expect(sent().at(-1)).toContain("cannot be put back");
    expect(liveRecords()[0].media).toHaveLength(2);
    expect(media.objects.size).toBe(6);
  });

  it("takes it off the record and then deletes its files", async () => {
    await handleDetachCallback(press(`rm:y:aaaaaaaaaaaaaaaa:${FIRST}`), env());

    const [record] = liveRecords();
    expect(record.media).toHaveLength(1);
    expect(record.media[0].src).toContain(SECOND);

    // Only that item's derivatives went.
    expect([...media.objects.keys()].every((key) => key.includes(SECOND))).toBe(true);
    expect(media.objects.size).toBe(3);

    expect(sent().at(-1)).toContain('Removed it from "A morning run"');
    expect(sent().at(-1)).toContain("One item is left");
    expect(sent().at(-1)).toContain("https://site.example/activities/?v=a-morning-run");
  });

  it("republishes the chunk rather than editing it", async () => {
    await handleDetachCallback(press(`rm:y:aaaaaaaaaaaaaaaa:${FIRST}`), env());

    // The original chunk still holds what it always held: that is what lets it
    // be cached for a year.
    const original = JSON.parse(content.objects.get(chunkKey("chunk0")) as string) as PublicRecord[];
    expect(original[0].media).toHaveLength(2);
  });

  it("is harmless when the same button is pressed twice", async () => {
    await handleDetachCallback(press(`rm:y:aaaaaaaaaaaaaaaa:${FIRST}`), env());
    const after = content.objects.size;

    await handleDetachCallback(press(`rm:y:aaaaaaaaaaaaaaaa:${FIRST}`), env());

    expect(sent().at(-1)).toContain("not on the activity any more");
    expect(content.objects.size).toBe(after);
    expect(liveRecords()[0].media).toHaveLength(1);
  });

  it("says so when the last item goes", async () => {
    await handleDetachCallback(press(`rm:y:aaaaaaaaaaaaaaaa:${FIRST}`), env());
    await handleDetachCallback(press(`rm:y:aaaaaaaaaaaaaaaa:${SECOND}`), env());

    expect(liveRecords()[0].media).toHaveLength(0);
    expect(sent().at(-1)).toContain("no media left");
    expect(media.objects.size).toBe(0);
  });

  it("leaves everything alone when the record cannot be found", async () => {
    await handleDetachCallback(press(`rm:y:zzzzzzzzzzzzzzzz:${FIRST}`), env());

    expect(sent().at(-1)).toContain("could not find that activity");
    expect(media.objects.size).toBe(6);
  });

  /**
   * The record is what a visitor reads, so it stops naming the item first. A
   * failed amendment must leave the files exactly where they are, or the page
   * would point at a picture that is already gone.
   */
  it("deletes nothing when the record could not be changed", async () => {
    content.failPutsFor(() => true);

    await handleDetachCallback(press(`rm:y:aaaaaaaaaaaaaaaa:${FIRST}`), env());

    expect(sent().at(-1)).toContain("Nothing was removed");
    expect(media.objects.size).toBe(6);
  });

  it("cancels without touching anything", async () => {
    await handleDetachCallback(press("rm:x"), env());

    expect(sent().at(-1)).toBe("Nothing was removed.");
    expect(liveRecords()[0].media).toHaveLength(2);
    expect(media.objects.size).toBe(6);
  });

  it("refuses a button that names nothing it can act on", async () => {
    await handleDetachCallback(press("rm:y:aaaaaaaaaaaaaaaa"), env());
    expect(sent().at(-1)).toContain("could not find that activity");
  });
});
