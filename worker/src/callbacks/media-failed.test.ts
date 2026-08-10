import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacSha256Hex } from "../crypto";
import { createDraft, loadDraft, saveDraft } from "../drafts/store";
import type { Draft, DraftRecord } from "../drafts/types";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { handleMediaFailed } from "./media-failed";

const SECRET = "callback-secret";
const JOB_TOKEN = "job-token-0123456789abcdef";

const RECORD: DraftRecord = {
  title: "Morning coffee",
  summary: "At the campus.",
  body: "A good start.",
  eventDate: "2026-08-05",
  tags: ["Coffee"],
  media: [{ mediaId: "media0", alt: "A cup on a table", caption: "The first of the day" }],
};

let storage: FakeBucket;
let content: FakeBucket;
/** Every Telegram call, as {method, body}. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ method: String(url).split("/").pop() ?? "", body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({
  PRIVATE_BUCKET: storage.bucket,
  CALLBACK_HMAC_SECRET: SECRET,
  TELEGRAM_BOT_TOKEN: "test-token",
});

/** A draft mid-flight: media filed, approved, dispatched to Actions. */
async function processingDraft(): Promise<Draft> {
  const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "coffee");
  const draft: Draft = {
    ...created,
    state: "processing",
    record: RECORD,
    originals: [
      { mediaId: "media0", type: "image", fileId: "f0", key: `originals/${created.activityId}/media0.jpg` },
    ],
    job: { jobToken: JOB_TOKEN, dispatchedAt: new Date().toISOString() },
  };
  await saveDraft(storage.bucket, draft);
  return draft;
}

function payload(draft: Draft, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ draftId: draft.draftId, jobId: JOB_TOKEN, stage: "sanitize", ...overrides });
}

/** Signs exactly as the workflow does: timestamp "." nonce "." raw body. */
async function callback(
  body: string,
  opts: { secret?: string; timestamp?: string; nonce?: string; signature?: string } = {},
): Promise<Request> {
  const timestamp = opts.timestamp ?? String(Date.now());
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const signature =
    opts.signature ?? (await hmacSha256Hex(opts.secret ?? SECRET, `${timestamp}.${nonce}.${body}`));

  return new Request("https://worker.example/callbacks/media-failed", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Callback-Timestamp": timestamp,
      "X-Callback-Nonce": nonce,
      "X-Callback-Signature": signature,
    },
    body,
  });
}

const sent = () => calls.filter((c) => c.method === "sendMessage");

function buttonsOn(call: { body: Record<string, unknown> } | undefined): string[] {
  const markup = call?.body.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
}

/**
 * The same authentication as the publishing callback, because it is the same
 * code. Repeated here rather than trusted: this route can interrupt a
 * publication that was going fine, so an unauthenticated caller reaching it
 * would be a denial of service against the author's own drafts.
 */
describe("authentication", () => {
  it("refuses a request carrying no signature at all", async () => {
    const draft = await processingDraft();
    const request = new Request("https://worker.example/callbacks/media-failed", {
      method: "POST",
      body: payload(draft),
    });

    expect((await handleMediaFailed(request, env())).status).toBe(401);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
  });

  it("refuses a signature made with the wrong secret", async () => {
    const draft = await processingDraft();
    const response = await handleMediaFailed(
      await callback(payload(draft), { secret: "not-the-secret" }),
      env(),
    );

    expect(response.status).toBe(401);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
  });

  it("refuses a signature older than the window", async () => {
    const draft = await processingDraft();
    const stale = String(Date.now() - 10 * 60 * 1000);
    const response = await handleMediaFailed(await callback(payload(draft), { timestamp: stale }), env());

    expect(response.status).toBe(401);
  });

  it("refuses a replay of a request that already landed", async () => {
    const draft = await processingDraft();
    const body = payload(draft);
    const nonce = "nonce-replayed-0001";

    expect((await handleMediaFailed(await callback(body, { nonce }), env())).status).toBe(200);
    expect((await handleMediaFailed(await callback(body, { nonce }), env())).status).toBe(401);
  });

  it("refuses every request when the secret is not configured", async () => {
    const draft = await processingDraft();
    const response = await handleMediaFailed(await callback(payload(draft)), {
      ...env(),
      CALLBACK_HMAC_SECRET: "",
    });

    expect(response.status).toBe(401);
  });
});

describe("binding the report to its job", () => {
  it("refuses a report for a draft that no longer exists", async () => {
    const draft = await processingDraft();
    await storage.bucket.delete(`drafts/${draft.draftId}/draft.json`);

    expect((await handleMediaFailed(await callback(payload(draft)), env())).status).toBe(400);
    expect(sent()).toHaveLength(0);
  });

  it("refuses a job token that is not the one dispatched", async () => {
    // A run superseded by a retry carries the previous token, and must not be
    // able to fail the attempt that replaced it.
    const draft = await processingDraft();
    const response = await handleMediaFailed(
      await callback(payload(draft, { jobId: "job-token-fedcba9876543210" })),
      env(),
    );

    expect(response.status).toBe(400);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
    expect(sent()).toHaveLength(0);
  });

  it("refuses a body that is not a report", async () => {
    expect((await handleMediaFailed(await callback("not json"), env())).status).toBe(400);
    expect((await handleMediaFailed(await callback('{"draftId":7}'), env())).status).toBe(400);
  });
});

describe("failing the draft", () => {
  it("moves it to failed and offers Retry and Cancel", async () => {
    const draft = await processingDraft();

    const response = await handleMediaFailed(await callback(payload(draft)), env());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "failed" });

    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.state).toBe("failed");
    expect(stored.preview?.messageId).toBe(77);
    expect(stored.preview?.token).toHaveLength(12);

    expect(buttonsOn(sent()[0])).toEqual(["Retry", "Cancel"]);
  });

  it("keeps everything a retry needs", async () => {
    // The same activity id above all: every derivative's name is built from it,
    // so a retry overwrites the half-written set rather than orphaning it.
    const draft = await processingDraft();
    await handleMediaFailed(await callback(payload(draft)), env());

    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.activityId).toBe(draft.activityId);
    expect(stored.record).toEqual(RECORD);
    expect(stored.originals).toEqual(draft.originals);
  });

  it("turns the stage into a sentence about what did not happen", async () => {
    const stages: Array<[string, string]> = [
      ["download", "could not be fetched"],
      ["sanitize", "metadata could not be stripped"],
      ["verify", "did not pass its checks"],
      ["upload", "could not be uploaded"],
      ["publish", "entry itself could not be published"],
      ["cancelled", "was stopped before it finished"],
    ];

    for (const [stage, expected] of stages) {
      calls = [];
      const draft = await processingDraft();
      await handleMediaFailed(await callback(payload(draft, { stage })), env());

      const text = sent()[0]?.body.text as string;
      expect(text).toContain("Publication failed.");
      expect(text).toContain(expected);
      expect(text).toContain("Retry runs it again");
    }
  });

  it("falls back to a vaguer sentence for a stage it has not heard of", async () => {
    // A workflow that grew a step still has a draft stuck behind it, and the
    // author would rather hear something vague than nothing.
    const draft = await processingDraft();
    await handleMediaFailed(await callback(payload(draft, { stage: "polishing" })), env());

    expect(sent()[0]?.body.text).toContain("did not finish");
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("failed");
  });

  it("says nothing that came out of a runner", async () => {
    // These steps run third-party actions over the author's own photographs.
    const draft = await processingDraft();
    await handleMediaFailed(
      await callback(payload(draft, { stage: "Error: exiftool exited 2 at /home/runner/work" })),
      env(),
    );

    const text = sent()[0]?.body.text as string;
    expect(text).not.toContain("exiftool");
    expect(text).not.toContain("/home/runner");
  });

  it("publishes nothing", async () => {
    const draft = await processingDraft();
    await handleMediaFailed(await callback(payload(draft)), env());

    expect(content.objects.size).toBe(0);
  });
});

describe("reports that arrive too late to act on", () => {
  it("answers a repeat without sending a second message", async () => {
    const draft = await processingDraft();
    await handleMediaFailed(await callback(payload(draft)), env());
    calls = [];

    const response = await handleMediaFailed(await callback(payload(draft)), env());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "already-failed" });
    expect(sent()).toHaveLength(0);
  });

  it("leaves a published draft alone and hands back its link", async () => {
    // A later step of the same run failed after the callback had already put
    // the record live. Chunks are immutable; there is nothing to undo.
    const draft = await processingDraft();
    await saveDraft(storage.bucket, {
      ...draft,
      state: "published",
      published: { recordId: "rec-1", url: "https://site.example/#activity" },
    });

    const response = await handleMediaFailed(await callback(payload(draft)), env());

    expect(await response.json()).toEqual({
      status: "already-published",
      url: "https://site.example/#activity",
    });
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("published");
    expect(sent()).toHaveLength(0);
  });

  it("leaves a draft waiting on the author's confirmation alone", async () => {
    // The media came back and is in front of the author. Failing it now would
    // throw away a confirmation that is live and correct.
    const draft = await processingDraft();
    await saveDraft(storage.bucket, {
      ...draft,
      state: "awaiting_approval",
      processed: { media: [], at: new Date().toISOString() },
      preview: { messageId: 5, token: "tok123456789" },
    });

    const response = await handleMediaFailed(await callback(payload(draft)), env());

    expect(await response.json()).toEqual({ status: "awaiting-confirmation" });
    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.state).toBe("awaiting_approval");
    expect(stored.preview?.token).toBe("tok123456789");
    expect(sent()).toHaveLength(0);
  });

  it("refuses a report for a draft that was never dispatched", async () => {
    const draft = await processingDraft();
    await saveDraft(storage.bucket, { ...draft, state: "awaiting_approval" });

    expect((await handleMediaFailed(await callback(payload(draft)), env())).status).toBe(400);
    expect(sent()).toHaveLength(0);
  });

  it("answers 500 when the draft cannot be written, so the run says so", async () => {
    // The nonce still has to claim, or this would be testing the signature
    // check rather than the write that records the failure.
    const draft = await processingDraft();
    storage.failPutsFor((key) => key.endsWith("draft.json"));

    const response = await handleMediaFailed(await callback(payload(draft)), env());

    expect(response.status).toBe(500);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
  });
});
