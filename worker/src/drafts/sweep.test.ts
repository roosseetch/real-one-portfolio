import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { createDraft, draftKey, loadDraft, saveDraft } from "./store";
import { setPendingEdit } from "./pending";
import { sweepStrandedDrafts, STRANDED_AFTER_MS } from "./sweep";
import type { Draft, DraftRecord } from "./types";

const RECORD: DraftRecord = {
  title: "Morning coffee",
  summary: "At the campus.",
  body: "A good start.",
  eventDate: "2026-08-05",
  tags: ["Coffee"],
  media: [{ mediaId: "media0", alt: "A cup", caption: "The first" }],
};

const NOW = new Date("2026-08-10T12:00:00.000Z");
/** Comfortably past the threshold, so a test never turns on the exact boundary. */
const LONG_AGO = new Date(NOW.getTime() - STRANDED_AFTER_MS - 60_000).toISOString();
const JUST_NOW = new Date(NOW.getTime() - 60_000).toISOString();

let storage: FakeBucket;
let calls: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  storage = createFakeBucket();
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ method: String(url).split("/").pop() ?? "", body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({ PRIVATE_BUCKET: storage.bucket, TELEGRAM_BOT_TOKEN: "test-token" });

/** A draft dispatched to Actions at `dispatchedAt` and never heard from since. */
async function processing(dispatchedAt: string, overrides: Partial<Draft> = {}): Promise<Draft> {
  const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "coffee");
  const draft: Draft = {
    ...created,
    state: "processing",
    record: RECORD,
    originals: [
      { mediaId: "media0", type: "image", fileId: "f0", key: `originals/${created.activityId}/media0.jpg` },
    ],
    job: { jobToken: "job-token-0123456789abcdef", dispatchedAt },
    updatedAt: dispatchedAt,
    ...overrides,
  };
  await saveDraft(storage.bucket, draft);
  return draft;
}

const sent = () => calls.filter((c) => c.method === "sendMessage");

function buttonsOn(call: { body: Record<string, unknown> } | undefined): string[] {
  const markup = call?.body.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
}

describe("sweeping drafts nothing came back for", () => {
  it("fails a draft stranded past the threshold and offers Retry and Cancel", async () => {
    const draft = await processing(LONG_AGO);

    const result = await sweepStrandedDrafts(env(), NOW);

    expect(result).toEqual({ examined: 1, stranded: 1 });

    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.state).toBe("failed");
    expect(stored.preview?.token).toHaveLength(12);

    expect(sent()[0]?.body.text).toContain("never came back");
    expect(buttonsOn(sent()[0])).toEqual(["Retry", "Cancel"]);
  });

  it("keeps everything a retry needs", async () => {
    const draft = await processing(LONG_AGO);
    await sweepStrandedDrafts(env(), NOW);

    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.activityId).toBe(draft.activityId);
    expect(stored.record).toEqual(RECORD);
    expect(stored.originals).toEqual(draft.originals);
  });

  it("leaves a draft that could still honestly be running", async () => {
    const draft = await processing(JUST_NOW);

    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 1, stranded: 0 });
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
    expect(sent()).toHaveLength(0);
  });

  it("touches no draft in any other state, however old", async () => {
    // Only `processing` means "something is supposed to come back". A draft
    // awaiting approval is waiting on a person, and has been for weeks before.
    for (const state of ["draft", "awaiting_approval", "published", "failed", "cancelled"] as const) {
      await processing(LONG_AGO, { state });
    }

    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 5, stranded: 0 });
    expect(sent()).toHaveLength(0);
  });

  it("leaves a draft whose record is already live", async () => {
    // The callback published and then failed to write the state back. There is
    // nothing to fail: the record is immutable and the author has its link.
    const draft = await processing(LONG_AGO, {
      published: { recordId: "rec-1", url: "https://site.example/#activity" },
    });

    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 1, stranded: 0 });
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
    expect(sent()).toHaveLength(0);
  });

  it("falls back to the draft's own last write when no job was dispatched", async () => {
    // A retry that publishes inline moves the draft to `processing` with no job.
    // If the isolate died there, the draft is stranded just the same.
    const draft = await processing(LONG_AGO, { job: null, updatedAt: LONG_AGO });

    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 1, stranded: 1 });
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("failed");
  });

  it("leaves a draft whose age cannot be read rather than guessing", async () => {
    const draft = await processing(LONG_AGO, { job: null, updatedAt: "not a date" });

    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 1, stranded: 0 });
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
  });

  it("reads drafts and nothing else under the prefix", async () => {
    // There are far more nonces than drafts. Reading each one would make a
    // quarter-hourly sweep cost more than everything else the Worker does.
    await processing(LONG_AGO);
    await setPendingEdit(storage.bucket, 99, "aaaaaaaaaaaaaaaa");
    for (let i = 0; i < 5; i++) {
      storage.objects.set(`drafts/callback-nonces/nonce-${i}.json`, "{}");
    }
    storage.objects.set("logs/2026-08-10/whatever.json", "{}");

    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 1, stranded: 1 });
  });

  it("names only the object key when it reports one, never the draft", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));

    const draft = await processing(LONG_AGO);
    await sweepStrandedDrafts(env(), NOW);

    expect(errors.join("\n")).toContain(draftKey(draft.draftId));
    expect(errors.join("\n")).not.toContain("coffee");
    expect(errors.join("\n")).not.toContain("99");
  });

  it("keeps going when one draft is unreadable", async () => {
    // One corrupt object must not stop the others being noticed.
    await processing(LONG_AGO);
    storage.objects.set("drafts/bbbbbbbbbbbbbbbb/draft.json", "{not json");
    await processing(LONG_AGO);

    const result = await sweepStrandedDrafts(env(), NOW);

    expect(result.examined).toBe(3);
    expect(result.stranded).toBe(2);
  });

  it("reports nothing when there is nothing to report", async () => {
    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 0, stranded: 0 });
    expect(sent()).toHaveLength(0);
  });

  it("survives a bucket that will not list", async () => {
    vi.spyOn(storage.bucket, "list").mockRejectedValue(new Error("R2 unavailable"));

    await expect(sweepStrandedDrafts(env(), NOW)).resolves.toEqual({ examined: 0, stranded: 0 });
  });

  it("pages through more drafts than one list returns", async () => {
    // The fake pages at whatever limit it is given; this proves the cursor is
    // followed rather than the first page being mistaken for everything.
    for (let i = 0; i < 3; i++) await processing(LONG_AGO);
    const list = storage.bucket.list.bind(storage.bucket);
    vi.spyOn(storage.bucket, "list").mockImplementation((options) => list({ ...options, limit: 1 }));

    expect(await sweepStrandedDrafts(env(), NOW)).toEqual({ examined: 3, stranded: 3 });
  });
});
