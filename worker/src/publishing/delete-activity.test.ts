import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicMedia, PublicRecord } from "../content/records";
import { takePending } from "../drafts/pending";
import { activityPrefix } from "../media/published";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramCallbackQuery } from "../telegram/types";
import {
  applyDeleteTarget,
  formatDeletionQuestion,
  handleDeleteCallback,
  isDeleteCallback,
  promptForDeletion,
} from "./delete-activity";

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

function record(
  id: string,
  title: string,
  body: string | null = null,
  mediaItems: PublicMedia[] = [],
): PublicRecord {
  return {
    id,
    title,
    summary: null,
    body,
    eventDate: null,
    publishedAt: "2026-08-10T09:00:00.000Z",
    tags: [],
    media: mediaItems,
  };
}

/** Lays down chunks and the manifest that points at them, as publication would have. */
function publish(chunks: PublicRecord[][]): void {
  const manifest: Manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    recordsPerFile: 10,
    totalRecords: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    records: chunks.map((chunk, index) => ({ id: `chunk${index}`, sha256: "x", count: chunk.length })),
    latest: chunks.length === 0 ? null : `chunk${chunks.length - 1}`,
  };

  for (const [index, chunk] of chunks.entries()) {
    content.objects.set(chunkKey(`chunk${index}`), JSON.stringify(chunk));
  }
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

function keyboardOf(index = -1): string[] {
  const call = calls.filter((c) => c.method === "sendMessage").at(index);
  return (
    (call?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> })
      ?.inline_keyboard ?? []
  )
    .flat()
    .map((button) => button.callback_data);
}

function manifest(): Manifest {
  return JSON.parse(content.objects.get(MANIFEST_KEY) as string) as Manifest;
}

/** Every record the site would read now, across whatever chunks the manifest names. */
function liveRecords(): PublicRecord[] {
  return manifest().records.flatMap(
    (entry) => JSON.parse(content.objects.get(chunkKey(entry.id)) as string) as PublicRecord[],
  );
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

describe("isDeleteCallback", () => {
  it("claims its own namespace and nothing else", () => {
    expect(isDeleteCallback("da:p:record")).toBe(true);
    expect(isDeleteCallback("da:x")).toBe(true);
    expect(isDeleteCallback("rm:p:record")).toBe(false);
    expect(isDeleteCallback("am:p:d:t:r")).toBe(false);
    expect(isDeleteCallback("l:p:record")).toBe(false);
    expect(isDeleteCallback("p:draft123:token123")).toBe(false);
    expect(isDeleteCallback(undefined)).toBe(false);
  });
});

describe("promptForDeletion", () => {
  it("asks for a link and offers the newest activities beside it", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "A morning run"), record("bbbbbbbbbbbbbbbb", "A note")]]);

    await promptForDeletion(env(), CHAT);

    expect(sent().at(-1)).toContain("Send its link, its slug or its id");
    expect(keyboardOf()).toEqual(["da:p:bbbbbbbbbbbbbbbb", "da:p:aaaaaaaaaaaaaaaa", "da:x"]);
  });

  /**
   * The request was to be able to paste the link of the entry to delete, so the
   * answer has to be typeable without a button being pressed first.
   */
  it("arms the chat so the next message can simply be the link", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "A morning run")]]);

    await promptForDeletion(env(), CHAT);

    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "delete-target" });
  });

  it("says so, and arms nothing, when there is nothing published", async () => {
    publish([]);

    await promptForDeletion(env(), CHAT);

    expect(sent().at(-1)).toContain("Nothing has been published yet");
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });

  /**
   * A pointer armed here would swallow the author's next note as a reference to
   * an activity that was never offered.
   */
  it("arms nothing when the activities cannot be read at all", async () => {
    const exploding = {
      get: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;

    await promptForDeletion({ ...env(), CONTENT_BUCKET: exploding }, CHAT);

    expect(sent().at(-1)).toContain("could not read the published activities");
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });
});

describe("naming the activity", () => {
  beforeEach(() => {
    publish([[record("aaaaaaaaaaaaaaaa", "A morning run", "Eight kilometres before work.")]]);
  });

  it("takes a pasted link and quotes back the title and the text", async () => {
    await applyDeleteTarget(env(), CHAT, "https://site.example/activities/?v=a-morning-run");

    expect(sent().at(-1)).toContain("Delete this activity?");
    expect(sent().at(-1)).toContain("A morning run");
    expect(sent().at(-1)).toContain("Eight kilometres before work.");
    expect(keyboardOf()).toEqual(["da:y:aaaaaaaaaaaaaaaa", "da:x"]);
  });

  it("takes the slug on its own", async () => {
    await applyDeleteTarget(env(), CHAT, "a-morning-run");
    expect(sent().at(-1)).toContain("Delete this activity?");
  });

  it("takes the id on its own", async () => {
    await applyDeleteTarget(env(), CHAT, "aaaaaaaaaaaaaaaa");
    expect(sent().at(-1)).toContain("Delete this activity?");
  });

  /**
   * Any activity, not a recent one. Every other flow looks three chunks back;
   * this one has to reach an entry from the beginning of the archive.
   */
  it("finds an activity far older than the other flows look", async () => {
    publish([
      [record("oooooooooooooooo", "The oldest thing here")],
      [record("bbbbbbbbbbbbbbbb", "Second")],
      [record("cccccccccccccccc", "Third")],
      [record("dddddddddddddddd", "Fourth")],
      [record("aaaaaaaaaaaaaaaa", "Newest")],
    ]);

    await applyDeleteTarget(env(), CHAT, "oooooooooooooooo");

    expect(sent().at(-1)).toContain("The oldest thing here");
  });

  it("re-arms the chat when nothing matches, so the next try is not read as a note", async () => {
    await applyDeleteTarget(env(), CHAT, "zzzzzzzzzzzzzzzz");

    expect(sent().at(-1)).toContain("could not find an activity with that id or link");
    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "delete-target" });
  });

  it("spends the pointer when a button is pressed instead", async () => {
    await promptForDeletion(env(), CHAT);
    await handleDeleteCallback(press("da:p:aaaaaaaaaaaaaaaa"), env());

    expect(sent().at(-1)).toContain("Delete this activity?");
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });

  it("says so when a button names an activity that has since gone", async () => {
    await handleDeleteCallback(press("da:p:zzzzzzzzzzzzzzzz"), env());
    expect(sent().at(-1)).toContain("could not find that activity");
  });
});

describe("the question", () => {
  it("names what goes with the entry and what cannot be undone", () => {
    const entry = record("aaaaaaaaaaaaaaaa", "A morning run", "Eight kilometres.", [
      item(FIRST),
      item(SECOND, "video"),
    ]);

    const question = formatDeletionQuestion(entry, "https://site.example/activities/?v=a-morning-run");

    expect(question).toContain("1 photo and 1 video go with it.");
    expect(question).toContain("Published 2026-08-10");
    expect(question).toContain("https://site.example/activities/?v=a-morning-run");
    expect(question).toContain("for good");
    expect(question).toContain("LinkedIn");
  });

  it("falls back to the summary when the entry has no body", () => {
    const entry = { ...record("aaaaaaaaaaaaaaaa", "A note"), summary: "The short version." };
    expect(formatDeletionQuestion(entry, "https://site.example")).toContain("The short version.");
  });

  /**
   * The link, the media count and the consequences are what the author is being
   * asked to weigh. A long body must not be what pushes them off the end.
   */
  it("cuts the text rather than the consequences, and says that it did", () => {
    const entry = record("aaaaaaaaaaaaaaaa", "A long one", "x".repeat(9000), [item(FIRST)]);

    const question = formatDeletionQuestion(entry, "https://site.example/activities/?v=a-long-one");

    expect(question.length).toBeLessThanOrEqual(4096);
    expect(question).toContain("[Text truncated.");
    expect(question).toContain("1 photo goes with it.");
    expect(question).toContain("https://site.example/activities/?v=a-long-one");
    expect(question.endsWith("no longer exist.")).toBe(true);
  });

  /** A record published before `publishedAt` existed is exactly what this flow is for. */
  it("asks about a record that carries no publication date", () => {
    const entry = { ...record("aaaaaaaaaaaaaaaa", "An old one") } as Partial<PublicRecord>;
    delete entry.publishedAt;

    const question = formatDeletionQuestion(entry as PublicRecord, "https://site.example");

    expect(question).toContain("An old one");
    expect(question).not.toContain("Published");
  });
});

describe("deleting", () => {
  beforeEach(() => {
    publish([
      [
        record("aaaaaaaaaaaaaaaa", "A morning run", "Eight kilometres.", [item(FIRST), item(SECOND)]),
        record("bbbbbbbbbbbbbbbb", "A note"),
      ],
    ]);
    fill(FIRST);
    fill(SECOND);
  });

  /** The whole point of the second question: nothing moves until it is answered. */
  it("touches nothing until the confirmation is pressed", async () => {
    await applyDeleteTarget(env(), CHAT, "aaaaaaaaaaaaaaaa");

    expect(liveRecords()).toHaveLength(2);
    expect(media.objects.size).toBe(6);
  });

  it("takes the record off the site and then deletes its files", async () => {
    await handleDeleteCallback(press("da:y:aaaaaaaaaaaaaaaa"), env());

    expect(liveRecords().map((r) => r.id)).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(media.objects.size).toBe(0);

    expect(sent().at(-1)).toContain('Deleted "A morning run"');
    expect(sent().at(-1)).toContain("One activity is left");
  });

  it("leaves the media of every other activity alone", async () => {
    await handleDeleteCallback(press("da:y:bbbbbbbbbbbbbbbb"), env());

    expect(liveRecords().map((r) => r.id)).toEqual(["aaaaaaaaaaaaaaaa"]);
    expect(media.objects.size).toBe(6);
  });

  it("republishes the chunk rather than editing it", async () => {
    await handleDeleteCallback(press("da:y:aaaaaaaaaaaaaaaa"), env());

    // The original chunk still holds what it always held: that is what lets it
    // be cached for a year.
    const original = JSON.parse(content.objects.get(chunkKey("chunk0")) as string) as PublicRecord[];
    expect(original).toHaveLength(2);
    expect(manifest().records[0].id).not.toBe("chunk0");
  });

  it("leaves the manifest counting what is actually there", async () => {
    await handleDeleteCallback(press("da:y:aaaaaaaaaaaaaaaa"), env());

    expect(manifest().totalRecords).toBe(1);
    expect(manifest().records[0].count).toBe(1);
  });

  it("is harmless when the same button is pressed twice", async () => {
    await handleDeleteCallback(press("da:y:aaaaaaaaaaaaaaaa"), env());
    const after = content.objects.size;

    await handleDeleteCallback(press("da:y:aaaaaaaaaaaaaaaa"), env());

    expect(sent().at(-1)).toContain("could not find that activity");
    expect(content.objects.size).toBe(after);
    expect(liveRecords()).toHaveLength(1);
  });

  it("cancels without touching anything", async () => {
    await handleDeleteCallback(press("da:x"), env());

    expect(sent().at(-1)).toBe("Nothing was deleted.");
    expect(liveRecords()).toHaveLength(2);
    expect(media.objects.size).toBe(6);
    // The question is answered, so the promise that goes with it is spent.
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });

  /**
   * The record is what a visitor reads, so it goes first. A failed retraction
   * must leave the files exactly where they are, or a live page would point at
   * pictures that are already gone.
   */
  it("deletes no files when the record could not be taken off the site", async () => {
    content.failPutsFor(() => true);

    await handleDeleteCallback(press("da:y:aaaaaaaaaaaaaaaa"), env());

    expect(sent().at(-1)).toContain("still on the site");
    expect(media.objects.size).toBe(6);
    expect(liveRecords()).toHaveLength(2);
  });

  it("deletes an activity whose media it cannot locate, and leaves those files", async () => {
    publish([
      [
        record("cccccccccccccccc", "Elsewhere", null, [
          { type: "image", src: "https://elsewhere.example/some/other/layout.jpg", alt: null, caption: null },
        ]),
      ],
    ]);

    await handleDeleteCallback(press("da:y:cccccccccccccccc"), env());

    expect(liveRecords()).toHaveLength(0);
    expect(sent().at(-1)).toContain("Nothing is published now");
  });

  it("drops the manifest entry when the last record of a chunk goes", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "Old")], [record("bbbbbbbbbbbbbbbb", "New")]]);

    await handleDeleteCallback(press("da:y:bbbbbbbbbbbbbbbb"), env());

    // No empty chunk is published, and `latest` falls back to the newest one
    // that is still there — or the next publication would append to nothing.
    expect(manifest().records.map((entry) => entry.id)).toEqual(["chunk0"]);
    expect(manifest().latest).toBe("chunk0");
    expect(manifest().totalRecords).toBe(1);
  });

  it("leaves an empty manifest behind when the last activity of all goes", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "The only one")]]);

    await handleDeleteCallback(press("da:y:aaaaaaaaaaaaaaaa"), env());

    expect(manifest().records).toEqual([]);
    expect(manifest().latest).toBeNull();
    expect(manifest().totalRecords).toBe(0);
    expect(sent().at(-1)).toContain("Nothing is published now");
  });

  it("refuses a button that names nothing it can act on", async () => {
    await handleDeleteCallback(press("da:y:"), env());
    expect(sent().at(-1)).toContain("could not find that activity");
  });
});
