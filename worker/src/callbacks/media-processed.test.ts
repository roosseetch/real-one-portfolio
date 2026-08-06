import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManifest, emptyManifest, readManifest } from "../content/manifest";
import { hmacSha256Hex } from "../crypto";
import { createDraft, loadDraft, saveDraft } from "../drafts/store";
import type { Draft, DraftRecord } from "../drafts/types";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { handleMediaProcessed } from "./media-processed";

const SECRET = "callback-secret";
const MEDIA_BASE = "https://media.example";

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
let sent: string[];

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (typeof body.text === "string") sent.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({
  PRIVATE_BUCKET: storage.bucket,
  CONTENT_BUCKET: content.bucket,
  CALLBACK_HMAC_SECRET: SECRET,
  MEDIA_BASE_URL: MEDIA_BASE,
  SITE_BASE_URL: "https://site.example",
  TELEGRAM_BOT_TOKEN: "test-token",
});

/** A draft mid-flight: media filed, approved, dispatched to Actions. */
async function processingDraft(): Promise<Draft> {
  await createManifest(content.bucket, emptyManifest());
  const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "coffee");
  const draft: Draft = {
    ...created,
    state: "processing",
    record: RECORD,
    originals: [
      { mediaId: "media0", type: "image", fileId: "f0", key: `originals/${created.activityId}/media0.jpg` },
    ],
    job: { jobToken: "job-token-0123456789abcdef", dispatchedAt: new Date().toISOString() },
  };
  await saveDraft(storage.bucket, draft);
  return draft;
}

function payload(draft: Draft, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    draftId: draft.draftId,
    jobId: draft.job?.jobToken,
    processedAt: new Date().toISOString(),
    media: [
      {
        sourceId: "media0",
        type: "image",
        src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1600.webp`,
        thumbnail: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-320.webp`,
        width: 1600,
        height: 1067,
      },
    ],
    ...overrides,
  });
}

/** Signs exactly as the workflow does: timestamp "." nonce "." raw body. */
async function callback(
  body: string,
  opts: { secret?: string; timestamp?: string; nonce?: string; signature?: string } = {},
): Promise<Request> {
  const timestamp = opts.timestamp ?? String(Date.now());
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const signature = opts.signature ?? (await hmacSha256Hex(opts.secret ?? SECRET, `${timestamp}.${nonce}.${body}`));

  return new Request("https://worker.example/callbacks/media-processed", {
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

describe("the ten checks of spec §13.3", () => {
  it("1. refuses a stale timestamp", async () => {
    const draft = await processingDraft();
    const old = String(Date.now() - 10 * 60 * 1000);
    const response = await handleMediaProcessed(await callback(payload(draft), { timestamp: old }), env());

    expect(response.status).toBe(401);
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
  });

  it("2. refuses a wrong signature", async () => {
    const draft = await processingDraft();
    const response = await handleMediaProcessed(await callback(payload(draft), { secret: "not-the-secret" }), env());
    expect(response.status).toBe(401);
  });

  it("2. refuses a body altered after signing", async () => {
    // The signature covers the raw body, so changing one character invalidates it.
    const draft = await processingDraft();
    const signed = payload(draft);
    const request = await callback(signed);
    const tampered = new Request(request, { body: signed.replace("1600", "9999") });

    expect((await handleMediaProcessed(tampered, env())).status).toBe(401);
  });

  it("3. compares in constant time", async () => {
    // A prefix of the real signature must not pass; the length fold is what
    // makes that hold.
    const draft = await processingDraft();
    const body = payload(draft);
    const timestamp = String(Date.now());
    const nonce = "nonce-prefix-check";
    const real = await hmacSha256Hex(SECRET, `${timestamp}.${nonce}.${body}`);
    const request = await callback(body, { timestamp, nonce, signature: real.slice(0, -1) });

    expect((await handleMediaProcessed(request, env())).status).toBe(401);
  });

  it("4. refuses a replayed nonce", async () => {
    // Same signed request twice: the first publishes, the second is a replay.
    const draft = await processingDraft();
    const body = payload(draft);
    const timestamp = String(Date.now());
    const nonce = "nonce-replayed-once";
    const signature = await hmacSha256Hex(SECRET, `${timestamp}.${nonce}.${body}`);

    const first = await handleMediaProcessed(await callback(body, { timestamp, nonce, signature }), env());
    expect(first.status).toBe(200);

    const second = await handleMediaProcessed(await callback(body, { timestamp, nonce, signature }), env());
    expect(second.status).toBe(401);
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(1);
  });

  it("5. refuses an unknown draft", async () => {
    const draft = await processingDraft();
    const body = payload(draft, { draftId: "aaaaaaaaaaaaaaaa" });
    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });

  it("6. refuses a draft that is not processing", async () => {
    const draft = await processingDraft();
    await saveDraft(storage.bucket, { ...draft, state: "awaiting_approval" });
    expect((await handleMediaProcessed(await callback(payload(draft)), env())).status).toBe(400);
  });

  it("7. refuses a job id that does not match the dispatch", async () => {
    const draft = await processingDraft();
    const body = payload(draft, { jobId: "some-other-job-token-here" });
    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });

  it("8. refuses media ids the draft does not have", async () => {
    const draft = await processingDraft();
    const body = payload(draft, {
      media: [{ sourceId: "not-ours", type: "image", src: `${MEDIA_BASE}/media/x.webp` }],
    });
    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });

  it("8. refuses an empty media list", async () => {
    expect(
      (await handleMediaProcessed(await callback(payload(await processingDraft(), { media: [] })), env())).status,
    ).toBe(400);
  });

  it("9. refuses a URL on another host", async () => {
    // A signed callback naming an attacker's host would otherwise put their
    // images on her site.
    const draft = await processingDraft();
    const body = payload(draft, {
      media: [{ sourceId: "media0", type: "image", src: "https://evil.example/media/x.webp" }],
    });
    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });

  it("9. refuses a host that merely starts with the media domain", async () => {
    const draft = await processingDraft();
    const body = payload(draft, {
      media: [{ sourceId: "media0", type: "image", src: `${MEDIA_BASE}.evil.test/media/x.webp` }],
    });
    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });

  it("9. checks the thumbnail too, not only the main URL", async () => {
    const draft = await processingDraft();
    const body = payload(draft, {
      media: [
        {
          sourceId: "media0",
          type: "image",
          src: `${MEDIA_BASE}/media/ok.webp`,
          thumbnail: "https://evil.example/thumb.webp",
        },
      ],
    });
    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });

  it("refuses everything when the secret is not configured", async () => {
    const draft = await processingDraft();
    const response = await handleMediaProcessed(await callback(payload(draft)), {
      ...env(),
      CALLBACK_HMAC_SECRET: "",
    });
    expect(response.status).toBe(401);
  });

  it("says nothing about which check failed", async () => {
    // A caller learns that it failed, not how to get closer.
    const draft = await processingDraft();
    const wrongJob = await handleMediaProcessed(await callback(payload(draft, { jobId: "x" })), env());
    const wrongMedia = await handleMediaProcessed(
      await callback(payload(draft, { media: [{ sourceId: "nope", type: "image", src: `${MEDIA_BASE}/a.webp` }] })),
      env(),
    );

    expect(await wrongJob.text()).toBe(await wrongMedia.text());
  });
});

describe("publishing on a valid callback", () => {
  it("publishes the record with the sanitised URLs", async () => {
    const draft = await processingDraft();
    const response = await handleMediaProcessed(await callback(payload(draft)), env());

    expect(response.status).toBe(200);
    const manifest = (await readManifest(content.bucket))!.manifest;
    expect(manifest.totalRecords).toBe(1);

    const chunk = JSON.parse(content.objects.get(`content/records-${manifest.latest}.json`) as unknown as string);
    expect(chunk[0].media[0].src).toContain(MEDIA_BASE);
    expect(chunk[0].title).toBe("Morning coffee");
  });

  it("takes alt and caption from the draft, not the callback", async () => {
    // Those are the author's approved words; Actions has no business changing
    // them, and the callback is not where they would be reviewed.
    const draft = await processingDraft();
    await handleMediaProcessed(await callback(payload(draft)), env());

    const manifest = (await readManifest(content.bucket))!.manifest;
    const chunk = JSON.parse(content.objects.get(`content/records-${manifest.latest}.json`) as unknown as string);
    expect(chunk[0].media[0].alt).toBe("A cup on a table");
    expect(chunk[0].media[0].caption).toBe("The first of the day");
  });

  it("retires the draft and sends the link", async () => {
    const draft = await processingDraft();
    await handleMediaProcessed(await callback(payload(draft)), env());

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("published");
    expect(stored?.published?.url).toBe("https://site.example/#activity");
    expect(sent).toEqual(["Published. https://site.example/#activity"]);
  });

  it("keeps the private side out of the published record", async () => {
    const draft = await processingDraft();
    await handleMediaProcessed(await callback(payload(draft)), env());

    const manifest = (await readManifest(content.bucket))!.manifest;
    const body = content.objects.get(`content/records-${manifest.latest}.json`) as unknown as string;
    expect(body).not.toContain(draft.draftId);
    expect(body).not.toContain(draft.job!.jobToken);
    expect(body).not.toContain("originals/");
  });
});

describe("idempotency (spec §13.4)", () => {
  it("returns the existing result instead of publishing twice", async () => {
    const draft = await processingDraft();
    await handleMediaProcessed(await callback(payload(draft)), env());
    sent.length = 0;

    // A fresh nonce, so this is a genuine repeat rather than a replay.
    const repeat = await handleMediaProcessed(await callback(payload(draft)), env());

    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ status: "already-published" });
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(1);
    // No second success message either.
    expect(sent).toEqual([]);
  });
});
