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
/** Every Telegram call, as {method, body}, for the sends that carry no text. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  sent = [];
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ method: String(url).split("/").pop() ?? "", body });
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

/** The same, with the one original filed as a video rather than a picture. */
async function videoDraft(): Promise<Draft> {
  const draft = await processingDraft();
  const video: Draft = {
    ...draft,
    originals: [
      { mediaId: "media0", type: "video", fileId: "f0", key: `originals/${draft.activityId}/media0.mov` },
    ],
  };
  await saveDraft(storage.bucket, video);
  return video;
}

/** What the workflow's jq builds for a video: an mp4, and a poster to stand in. */
function videoPayload(
  draft: Draft,
  opts: { poster?: string; visibleChanges?: unknown } = {},
): string {
  const base = `${MEDIA_BASE}/media/activity-${draft.activityId}`;
  return payload(draft, {
    media: [
      {
        sourceId: "media0",
        type: "video",
        src: `${base}/media0-1280.mp4`,
        poster: opts.poster ?? `${base}/media0-poster-1280.webp`,
        thumbnail: `${base}/media0-poster-320.webp`,
        width: 1280,
        height: 720,
        // The sanitiser omits the field on a clip it changed in no visible way,
        // which is what the workflow's `// []` turns into an empty list.
        ...(opts.visibleChanges === undefined ? {} : { visibleChanges: opts.visibleChanges }),
      },
    ],
  });
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

  it("8. refuses a duplicate media id", async () => {
    const draft = await processingDraft();
    const item = {
      sourceId: "media0",
      type: "image",
      src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1600.webp`,
    };
    const body = payload(draft, { media: [item, item] });

    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });

  it("8. refuses a callback that omits one of the originals", async () => {
    const draft = await processingDraft();
    await saveDraft(storage.bucket, {
      ...draft,
      originals: [
        ...draft.originals,
        {
          mediaId: "media1",
          type: "image",
          fileId: "f1",
          key: `originals/${draft.activityId}/media1.jpg`,
        },
      ],
    });

    expect((await handleMediaProcessed(await callback(payload(draft)), env())).status).toBe(400);
  });

  it("8. refuses a media type that does not match its original", async () => {
    const draft = await processingDraft();
    const body = payload(draft, {
      media: [
        {
          sourceId: "media0",
          type: "video",
          src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0.mp4`,
        },
      ],
    });

    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
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
    expect(stored?.published?.url).toBe("https://site.example/activities/?v=morning-coffee");
    expect(sent).toEqual(["Published. https://site.example/activities/?v=morning-coffee"]);
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

  // The mismatch case above proves a video entry can be refused. This is the
  // other half: when the original really is a video, the poster survives into
  // the record, which is the only thing the site will have to show for it.
  it("publishes a video with its poster and thumbnail", async () => {
    const draft = await videoDraft();
    const response = await handleMediaProcessed(await callback(videoPayload(draft)), env());

    expect(response.status).toBe(200);
    const manifest = (await readManifest(content.bucket))!.manifest;
    const chunk = JSON.parse(content.objects.get(`content/records-${manifest.latest}.json`) as unknown as string);
    expect(chunk[0].media[0]).toMatchObject({
      type: "video",
      src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1280.mp4`,
      poster: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-poster-1280.webp`,
      thumbnail: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-poster-320.webp`,
    });
  });

  it("refuses a poster served from somewhere other than the media domain", async () => {
    // The poster is a URL like any other and gets the same host check; a
    // published record must not embed a third party's address.
    const draft = await videoDraft();
    const body = videoPayload(draft, { poster: "https://elsewhere.example/poster.webp" });

    expect((await handleMediaProcessed(await callback(body), env())).status).toBe(400);
  });
});

describe("the confirmation gate (spec Phase 6)", () => {
  const CHANGES = ["scaled from 3840x2160 to 1920x1080"];

  it("publishes a clip the transcode changed in no visible way", async () => {
    // The whole point of the gate being conditional: an ordinary clip is
    // published exactly the way a photo is, with nothing to answer.
    const draft = await videoDraft();
    const response = await handleMediaProcessed(await callback(videoPayload(draft, { visibleChanges: [] })), env());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "published" });
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(1);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("published");
  });

  it("publishes when the field is absent altogether", async () => {
    // Which is what an older sanitiser binary sends, and what the workflow's
    // `// []` produces from a manifest entry that omits it.
    const draft = await videoDraft();
    const response = await handleMediaProcessed(await callback(videoPayload(draft)), env());

    expect(await response.json()).toMatchObject({ status: "published" });
  });

  it("publishes nothing when the clip changed visibly", async () => {
    const draft = await videoDraft();
    const response = await handleMediaProcessed(
      await callback(videoPayload(draft, { visibleChanges: CHANGES })),
      env(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "awaiting-confirmation" });
    // Nothing public: no chunk, no manifest entry, so the site is as it was.
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
  });

  it("holds the draft with the processed media and a live button", async () => {
    const draft = await videoDraft();
    await handleMediaProcessed(await callback(videoPayload(draft, { visibleChanges: CHANGES })), env());

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("awaiting_approval");
    expect(stored?.preview?.messageId).toBe(1);
    expect(stored?.preview?.token).toHaveLength(12);
    // The URLs are kept because publishing later must use these files rather
    // than ask for the work a second time.
    expect(stored?.processed?.media[0]).toMatchObject({
      sourceId: "media0",
      type: "video",
      src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1280.mp4`,
      visibleChanges: CHANGES,
    });
  });

  it("sends the clip itself and names what changed", async () => {
    const draft = await videoDraft();
    await handleMediaProcessed(await callback(videoPayload(draft, { visibleChanges: CHANGES })), env());

    const album = calls.find((call) => call.method === "sendMediaGroup");
    expect(album?.body.media).toEqual([
      { type: "video", media: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1280.mp4` },
    ]);

    // The change is named rather than summarised, and the link repeated: Telegram
    // refuses a by-URL fetch over 20 MB, and the author still has to be able to
    // watch what they are approving.
    expect(sent[0]).toContain("scaled from 3840x2160 to 1920x1080");
    expect(sent[0]).toContain(`${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1280.mp4`);
    expect(sent[0]).toContain("Publishing this version?");
  });

  it("offers only Publish and Cancel", async () => {
    // The text was approved on the first pass and the file is finished, so a
    // Regenerate here could only be refused.
    const draft = await videoDraft();
    await handleMediaProcessed(await callback(videoPayload(draft, { visibleChanges: CHANGES })), env());

    const question = calls.find((call) => call.method === "sendMessage");
    const keyboard = (question?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> })
      .inline_keyboard;
    expect(keyboard.flat().map((button) => button.text)).toEqual(["Publish", "Cancel"]);
  });

  it("clamps what the pipeline says before repeating it to the author", async () => {
    // Signed, but it is put in front of a person: an unbounded list from a
    // process running third-party actions does not get to fill the chat.
    const draft = await videoDraft();
    const shouting = ["a".repeat(400), 42, "", "scaled", "b", "c", "d", "e", "f"];
    await handleMediaProcessed(await callback(videoPayload(draft, { visibleChanges: shouting })), env());

    const held = (await loadDraft(storage.bucket, draft.draftId))?.processed?.media[0].visibleChanges ?? [];
    expect(held).toHaveLength(5);
    expect(held[0]).toHaveLength(120);
    expect(held).not.toContain("");
    expect(held).not.toContain(42);
  });

  it("ignores changes claimed for a picture", async () => {
    // Only a video is transcoded. A picture claiming one is a pipeline that has
    // changed under us, not a question to put to the author — and it must not
    // become one, because the confirmation sends what it asks about as a video.
    const draft = await processingDraft();
    const body = payload(draft, {
      media: [
        {
          sourceId: "media0",
          type: "image",
          src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1600.webp`,
          visibleChanges: ["scaled from 3840x2160 to 1920x1080"],
        },
      ],
    });

    expect(await (await handleMediaProcessed(await callback(body), env())).json()).toMatchObject({
      status: "published",
    });
    expect(calls.map((call) => call.method)).not.toContain("sendMediaGroup");
  });

  it("answers a repeat of the same job rather than failing the run", async () => {
    // The job sanitised, uploaded and reported correctly. Whether a person has
    // looked at the result yet is not something a workflow run can fail over.
    const draft = await videoDraft();
    const body = videoPayload(draft, { visibleChanges: CHANGES });
    await handleMediaProcessed(await callback(body), env());
    calls.length = 0;

    const repeat = await handleMediaProcessed(await callback(body), env());

    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ status: "awaiting-confirmation" });
    // No second album, no second question, and no new token to invalidate the
    // buttons already on screen.
    expect(calls).toEqual([]);
  });

  it("refuses a repeat that does not carry the dispatched job token", async () => {
    const draft = await videoDraft();
    await handleMediaProcessed(await callback(videoPayload(draft, { visibleChanges: CHANGES })), env());

    const forged = payload(draft, {
      jobId: "some-other-job-token-here",
      media: [{ sourceId: "media0", type: "video", src: `${MEDIA_BASE}/media/x.mp4` }],
    });

    expect((await handleMediaProcessed(await callback(forged), env())).status).toBe(400);
  });
});

/**
 * The same job, the same runner, the same signed callback — and a draft that
 * exists only to put files on an activity that is already live. Only the last
 * step differs, and this is where the two part.
 */
describe("media added to an activity that already exists", () => {
  /** A record on the site, and a draft whose files are meant for it. */
  async function attachingDraft(recordId = "aaaaaaaaaaaaaaaa"): Promise<Draft> {
    const draft = await processingDraft();
    const attaching: Draft = { ...draft, record: null, attachment: { recordId } };
    await saveDraft(storage.bucket, attaching);

    content.objects.set(
      "content/records-chunk0.json",
      JSON.stringify([
        {
          id: "aaaaaaaaaaaaaaaa",
          title: "A morning run",
          summary: null,
          body: null,
          eventDate: null,
          publishedAt: "2026-08-10T09:00:00.000Z",
          tags: [],
          media: [],
        },
      ]),
    );
    content.objects.set(
      "content/manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-08-12T10:00:00.000Z",
        recordsPerFile: 10,
        totalRecords: 1,
        records: [{ id: "chunk0", sha256: "x", count: 1 }],
        latest: "chunk0",
      }),
    );

    return attaching;
  }

  it("amends the activity instead of publishing a second record", async () => {
    const draft = await attachingDraft();

    const response = await handleMediaProcessed(await callback(payload(draft)), env());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "attached",
      url: "https://site.example/activities/?v=a-morning-run",
    });

    const manifest = (await readManifest(content.bucket))?.manifest;
    expect(manifest?.totalRecords).toBe(1);

    const records = JSON.parse(
      content.objects.get(`content/records-${manifest?.records[0].id}.json`) as string,
    ) as Array<{ media: unknown[] }>;
    expect(records[0].media).toHaveLength(1);

    expect(sent.at(-1)).toContain('Added the file to "A morning run"');
  });

  /**
   * Nothing dispatched a draft that names no activity, so a callback describing
   * one is describing work nobody asked for.
   */
  it("refuses a callback for a draft that never chose an activity", async () => {
    const draft = await attachingDraft();
    await saveDraft(storage.bucket, { ...draft, attachment: { recordId: null } });

    const response = await handleMediaProcessed(await callback(payload(draft)), env());

    expect(response.status).toBe(400);
  });

  it("still asks about a video the transcode changed", async () => {
    const draft = await attachingDraft();
    const video: Draft = {
      ...draft,
      originals: [
        { mediaId: "media0", type: "video", fileId: "f0", key: `originals/${draft.activityId}/media0.mov` },
      ],
    };
    await saveDraft(storage.bucket, video);

    const response = await handleMediaProcessed(
      await callback(videoPayload(video, { visibleChanges: ["The audio was removed."] })),
      env(),
    );

    expect(await response.json()).toMatchObject({ status: "awaiting-confirmation" });
    // Nothing is on the activity until the author has looked at it.
    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("awaiting_approval");
    expect(stored?.published).toBeNull();
  });

  it("leaves the draft in processing when the activity has gone", async () => {
    const draft = await attachingDraft("zzzzzzzzzzzzzzzz");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleMediaProcessed(await callback(payload(draft)), env());

    expect(response.status).toBe(500);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("processing");
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
