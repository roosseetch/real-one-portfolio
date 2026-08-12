import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiRecord, createFakeAi, type AiStep } from "../test-support/ai";
import { chunkKey } from "../content/chunks";
import { createManifest, emptyManifest, readManifest } from "../content/manifest";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramCallbackQuery } from "../telegram/types";
import { handlePreviewCallback, parseCallbackData, sendPreview } from "./approval";
import { createDraft, loadDraft, saveDraft } from "./store";
import type { Draft, DraftRecord } from "./types";

const RECORD: DraftRecord = {
  title: "Morning run by the river",
  summary: "An easy 8 km before work.",
  body: "Cool air, quiet paths, and a good pace.",
  eventDate: "2026-07-28",
  tags: ["Jogging"],
  media: [],
};

let storage: FakeBucket;
let content: FakeBucket;
let media: FakeBucket;
/** Every Telegram call, as {method, body}. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;
/** What GitHub answers a dispatch with; see refuseDispatch. */
let dispatchStatus: number;

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  media = createFakeBucket();
  calls = [];
  dispatchStatus = 204;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const method = String(url).split("/").pop() ?? "";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });

    // GitHub answers a workflow dispatch with 204 and no body; Telegram answers
    // with 200 and a result. Getting this wrong is how a dispatch silently
    // looks like a failure.
    if (method === "dispatches") return new Response(null, { status: dispatchStatus });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function env(...steps: AiStep[]) {
  return {
    PRIVATE_BUCKET: storage.bucket,
    TELEGRAM_BOT_TOKEN: "test-token",
    CONTENT_BUCKET: content.bucket,
    MEDIA_BUCKET: media.bucket,
    SITE_BASE_URL: "https://site.example",
    GITHUB_REPOSITORY: "owner/repo",
    MEDIA_WORKFLOW_FILE: "process-media.yml",
    GITHUB_DISPATCH_TOKEN: "dispatch-token",
    AI: createFakeAi(...(steps.length > 0 ? steps : [aiRecord()])).AI,
  };
}

async function awaitingApproval(): Promise<Draft> {
  const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "an easy 8k");
  return sendPreview(env(), { ...created, record: RECORD });
}

function press(draft: Draft, code: string, token = draft.preview?.token): TelegramCallbackQuery {
  return { id: "cb-1", from: { id: 42 }, data: `${code}:${draft.draftId}:${token}` };
}

const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);

/** The labels on a send's inline keyboard, flattened, so a keyboard can be named rather than indexed. */
function buttonsOn(call: { body: Record<string, unknown> } | undefined): string[] {
  const markup = call?.body.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
}

/**
 * Makes GitHub turn down the next workflow dispatch, leaving every other call as
 * it was. A toggle rather than a second mock, so a test can refuse one dispatch
 * and let the retry's succeed.
 */
function refuseDispatch(refused = true): void {
  dispatchStatus = refused ? 403 : 204;
}

describe("sendPreview", () => {
  it("moves the draft to awaiting_approval and records the message and token", async () => {
    const draft = await awaitingApproval();

    expect(draft.state).toBe("awaiting_approval");
    expect(draft.preview?.messageId).toBe(4242);
    expect(draft.preview?.token).toHaveLength(12);
    expect(await loadDraft(storage.bucket, draft.draftId)).toEqual(draft);
  });

  it("mints a new token for every preview, retiring the previous one", async () => {
    // After a regeneration the older message is still in the chat, and its
    // Publish button must not publish text the draft no longer says.
    const first = await awaitingApproval();
    const second = await sendPreview(env(), first);

    expect(second.preview?.token).not.toBe(first.preview?.token);
  });

  it("does not transition twice when a second preview is sent", async () => {
    const second = await sendPreview(env(), await awaitingApproval());
    expect(second.state).toBe("awaiting_approval");
  });

  it("sends nothing for a draft with no record yet", async () => {
    const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "an easy 8k");
    const result = await sendPreview(env(), created);

    expect(result.state).toBe("draft");
    expect(calls).toHaveLength(0);
  });

  it("leaves the draft alone when Telegram refuses the message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "an easy 8k");
    const result = await sendPreview(env(), { ...created, record: RECORD });

    expect(result.state).toBe("draft");
    expect(result.preview).toBeNull();
  });
});

describe("parseCallbackData", () => {
  it("reads a well-formed payload", () => {
    expect(parseCallbackData("p:abc123def456ghjk:tok123456789")).toEqual({
      action: "publish",
      draftId: "abc123def456ghjk",
      token: "tok123456789",
    });
  });

  it("rejects anything malformed", () => {
    for (const data of [undefined, "", "p", "p:abc", "p:abc:tok:extra", "z:abc:tok", "p::tok", "p:abc:"]) {
      expect(parseCallbackData(data)).toBeNull();
    }
  });
});

describe("handlePreviewCallback", () => {
  it("always answers the query, so the button stops spinning", async () => {
    // A spinner that never stops reads as a broken bot rather than a declined
    // action, so this holds even for rejections.
    await handlePreviewCallback({ id: "cb-1", from: { id: 42 }, data: "garbage" }, env());
    expect(calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(1);
  });

  it("refuses a press for a draft that no longer exists", async () => {
    const query = { id: "cb-1", from: { id: 42 }, data: "p:aaaaaaaaaaaaaaaa:tok123456789" };
    await handlePreviewCallback(query, env());

    expect(answers()).toEqual(["This draft is no longer available."]);
  });

  it("refuses a press carrying a superseded token", async () => {
    const first = await awaitingApproval();
    await sendPreview(env(), first); // retires the first preview
    calls.length = 0;

    await handlePreviewCallback(press(first, "c", first.preview?.token), env());

    expect(answers()).toEqual(["This preview has been replaced. Use the newest one."]);
    expect(await loadDraft(storage.bucket, first.draftId)).toMatchObject({ state: "awaiting_approval" });
  });

  it("refuses a forged token", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "c", "000000000000"), env());

    expect(answers()).toEqual(["This preview has been replaced. Use the newest one."]);
  });

  it("refuses a press once the draft has left awaiting_approval", async () => {
    const draft = await awaitingApproval();
    // Cancel, then press again with the same still-known token.
    await saveDraft(storage.bucket, { ...draft, state: "published" });
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    expect(answers()).toEqual(["Already published."]);
  });

  it("cancels the draft, strips the buttons and confirms", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "c"), env());

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("cancelled");
    // Dropping the preview retires the buttons even if the message edit failed.
    expect(stored?.preview).toBeNull();
    expect(calls.map((c) => c.method)).toContain("editMessageReplyMarkup");
    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toBe("Cancelled. Nothing was published.");
  });

  it("keeps the cancelled draft for the lifecycle rule rather than deleting it", async () => {
    // Spec §7.4: a cancellation stays recoverable for seven days.
    const draft = await awaitingApproval();
    await handlePreviewCallback(press(draft, "c"), env());

    expect(storage.objects.has(`drafts/${draft.draftId}/draft.json`)).toBe(true);
  });

  it("cannot be cancelled twice", async () => {
    const draft = await awaitingApproval();
    await handlePreviewCallback(press(draft, "c"), env());
    calls.length = 0;

    await handlePreviewCallback(press(draft, "c"), env());

    // Says what happened rather than sending the author after a newer preview
    // that does not exist.
    expect(answers()).toEqual(["Already cancelled."]);
  });

  it("acknowledges Change media, whose flow lands with the photo pipeline", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "m"), env());

    expect(answers()).toEqual(["Not available yet."]);
    // Still approvable: nothing was acted on, so the buttons stay live.
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("awaiting_approval");
    expect(calls.map((c) => c.method)).not.toContain("editMessageReplyMarkup");
  });
});

describe("regenerate", () => {
  it("replaces the record and previews the whole entry again", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "r"), env(aiRecord({ title: "A different take" })));

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.record?.title).toBe("A different take");
    // Spec §7.3: the complete preview follows every change, not the diff.
    const preview = calls.find((c) => c.method === "sendMessage" && c.body.reply_markup);
    expect(preview?.body.text).toContain("A different take");
    expect(preview?.body.text).toContain("Is this the information and media that should become public?");
  });

  it("retires the superseded preview", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "r"), env());
    const stored = await loadDraft(storage.bucket, draft.draftId);

    expect(stored?.preview?.token).not.toBe(draft.preview?.token);
    // The old keyboard comes off, so no press can land on a message that is
    // no longer describing the draft.
    expect(calls.map((c) => c.method)).toContain("editMessageReplyMarkup");
  });

  it("answers the button before the model runs", async () => {
    // Generation takes seconds; Telegram gives up on an unanswered callback
    // long before that and the button would appear stuck.
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "r"), env());

    expect(calls[0].method).toBe("answerCallbackQuery");
    expect(answers()).toEqual(["Rewriting…"]);
  });

  it("rewrites from the author's note, showing the last attempt only as something to avoid", async () => {
    // The note stays the source of truth -- regenerating *from* the previous
    // output would compound its drift. The previous record goes in separately,
    // labelled as rejected, because temperature alone left a short note coming
    // back word-for-word identical.
    const fake = createFakeAi(aiRecord());
    const draft = await awaitingApproval();

    await handlePreviewCallback(press(draft, "r"), { ...env(), AI: fake.AI });

    const prompt = (fake.calls[0].input as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? "";
    expect(prompt).toContain("an easy 8k");
    expect(prompt).toContain("You already suggested this");
    expect(prompt).toContain("genuinely different");
  });

  it("keeps the existing record when the model is unavailable", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "r"), env(new Error("daily quota exceeded")));

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.record?.title).toBe("Morning run by the river");
    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toBe(
      "The draft has been saved. AI processing can continue later.",
    );
  });
});

describe("edit", () => {
  it("asks for the instruction and records that one is owed", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "e"), env());

    expect(answers()).toEqual(["Send the change you want."]);
    expect(storage.objects.has("drafts/pending/99.json")).toBe(true);
    // Nothing has changed yet, so the buttons stay live.
    expect(calls.map((c) => c.method)).not.toContain("editMessageReplyMarkup");
  });
});

describe("publish", () => {
  beforeEach(async () => {
    await createManifest(content.bucket, emptyManifest());
  });

  it("publishes the record and sends back the link", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    const loaded = await readManifest(content.bucket);
    expect(loaded?.manifest.totalRecords).toBe(1);
    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toBe(
      "Published. https://site.example/activities/?v=morning-run-by-the-river",
    );
  });

  it("retires the draft so no later press can act on it", async () => {
    const draft = await awaitingApproval();
    await handlePreviewCallback(press(draft, "p"), env());

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("published");
    expect(stored?.preview).toBeNull();
    expect(stored?.published?.url).toBe("https://site.example/activities/?v=morning-run-by-the-river");
  });

  it("strips the buttons off the approved preview", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    expect(calls.map((c) => c.method)).toContain("editMessageReplyMarkup");
  });

  it("publishes once however often the button is pressed", async () => {
    // Spec §24. Chunks are immutable, so a duplicate could not be edited out.
    const draft = await awaitingApproval();
    await handlePreviewCallback(press(draft, "p"), env());
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(1);
    expect(answers()).toEqual(["Already published."]);
  });

  it("hands back the existing link if the draft is somehow re-published", async () => {
    // The narrower guard: state says awaiting_approval but the record is
    // already live, which is what a failed bookkeeping write would leave.
    const draft = await awaitingApproval();
    await handlePreviewCallback(press(draft, "p"), env());
    const published = await loadDraft(storage.bucket, draft.draftId);
    await saveDraft(storage.bucket, { ...published!, state: "awaiting_approval", preview: draft.preview });
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(1);
    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toContain("Already published.");
  });

  it("keeps the draft approvable when publication fails", async () => {
    const draft = await awaitingApproval();
    calls.length = 0;

    // No manifest in this bucket, so publication refuses.
    await handlePreviewCallback(press(draft, "p"), {
      ...env(),
      CONTENT_BUCKET: createFakeBucket().bucket,
    });

    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("awaiting_approval");
    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toContain("Publication failed");
  });

  it("publishes only what the site is allowed to see", async () => {
    // Spec §24: public JSON contains only publishable fields. Asserted on the
    // key set rather than by substring — a random record id can contain a chat
    // id by coincidence, which would make a substring check pass or fail for
    // no reason.
    const draft = await awaitingApproval();
    await handlePreviewCallback(press(draft, "p"), env());

    const m = (await readManifest(content.bucket))!.manifest;
    const body = content.objects.get(chunkKey(m.latest!)) as unknown as string;
    const [published] = JSON.parse(body);

    expect(Object.keys(published).sort()).toEqual(
      ["body", "eventDate", "id", "media", "publishedAt", "summary", "tags", "title"],
    );
    expect(published.title).toBe("Morning run by the river");
    // The site orders the feed on this, so a record without one is a record that
    // cannot be placed.
    expect(published.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The private side of the draft never crosses over.
    expect(published.id).not.toBe(draft.draftId);
    expect(body).not.toContain(draft.draftId);
    expect(body).not.toContain("an easy 8k");
  });
});

describe("previewing media", () => {
  const withOriginals = async (
    count: number,
    type: "image" | "video" = "image",
    /** The stored object's extension, which is how the preview knows a WebP. */
    extension = "jpg",
  ) => {
    const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "at the campus");
    const originals = Array.from({ length: count }, (_, i) => ({
      mediaId: `media${i}`,
      type,
      fileId: `file-${i}`,
      key: `originals/${created.activityId}/media${i}.${extension}`,
    }));
    return sendPreview(env(), { ...created, record: RECORD, originals });
  };

  it("sends a single photo with the preview as its caption", async () => {
    // Spec §7.2: the author sees the picture and the words together.
    await withOriginals(1);

    const photo = calls.find((c) => c.method === "sendPhoto");
    expect(photo?.body.photo).toBe("file-0");
    expect(String(photo?.body.caption)).toContain("Is this the information and media that should become public?");
    expect(photo?.body.reply_markup).toBeDefined();
    expect(calls.map((c) => c.method)).not.toContain("sendMediaGroup");
  });

  /** Telegram refuses the listed methods, as it does with a .webp file reference. */
  const refusing = (...methods: string[]) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const method = String(url).split("/").pop() ?? "";
      calls.push({ method, body: JSON.parse(String(init?.body)) });
      if (methods.includes(method)) {
        return new Response(JSON.stringify({ ok: false, description: "wrong file identifier" }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
    });
  };

  it("re-sends the file as a document when Telegram refuses it as a photo", async () => {
    // A .webp sent as a file is a sticker to Telegram, so sendPhoto rejects the
    // file reference — but the same reference goes through as an attachment,
    // and the author gets to see what they are approving.
    refusing("sendPhoto");

    const draft = await withOriginals(1);

    expect(calls.map((c) => c.method)).toContain("sendPhoto");
    const attached = calls.find((c) => c.method === "sendDocument");
    expect(attached?.body.document).toBe("file-0");
    expect(calls.map((c) => c.method)).not.toContain("sendMessage");
    expect(draft.state).toBe("awaiting_approval");
  });

  it("puts the same caption and buttons on the document, so the draft is still approvable", async () => {
    refusing("sendPhoto");

    const draft = await withOriginals(1);

    const attached = calls.find((c) => c.method === "sendDocument");
    expect(String(attached?.body.caption)).toContain("Is this the information and media that should become public?");
    expect(attached?.body.reply_markup).toBeDefined();
    expect(draft.preview?.messageId).toBe(4242);
  });

  it("falls back to words only when neither a photo nor a document is accepted", async () => {
    // A sticker's own file reference is re-sendable through sendSticker alone,
    // which carries no caption. The draft must not be left unpreviewed over it:
    // the picture is already in the private bucket and will still be published.
    refusing("sendPhoto", "sendDocument");

    const draft = await withOriginals(1);

    const fallback = calls.find((c) => c.method === "sendMessage");
    expect(String(fallback?.body.text)).toContain("Is this the information and media that should become public?");
    expect(fallback?.body.reply_markup).toBeDefined();
    // The preview counts as shown, so the draft can actually be approved.
    expect(draft.state).toBe("awaiting_approval");
  });

  // Observed in production: every webp preview logged `sendPhoto failed with
  // status 400` and then succeeded on the rung below. Correct, but it spent a
  // round trip on a refusal and wrote a warning that reads like a fault.
  it("does not offer a webp to sendPhoto, which Telegram refuses every time", async () => {
    const draft = await withOriginals(1, "image", "webp");

    expect(calls.map((c) => c.method)).not.toContain("sendPhoto");
    const attached = calls.find((c) => c.method === "sendDocument");
    expect(attached?.body.document).toBe("file-0");
    expect(String(attached?.body.caption)).toContain("should become public?");
    expect(attached?.body.reply_markup).toBeDefined();
    expect(draft.state).toBe("awaiting_approval");
  });

  it("still falls back to words when the document is refused too", async () => {
    // Skipping a rung must not cost the rung below it.
    refusing("sendDocument");

    const draft = await withOriginals(1, "image", "webp");

    expect(String(calls.find((c) => c.method === "sendMessage")?.body.text)).toContain("should become public?");
    expect(draft.state).toBe("awaiting_approval");
  });

  it("sends several as an album plus a separate control message", async () => {
    // Telegram allows no buttons on a media group, which is exactly why the
    // spec pairs one with a control message carrying the text and the decision.
    await withOriginals(3);

    const album = calls.find((c) => c.method === "sendMediaGroup");
    expect((album?.body.media as unknown[]).length).toBe(3);
    expect(album?.body.reply_markup).toBeUndefined();

    const control = calls.find((c) => c.method === "sendMessage");
    expect(String(control?.body.text)).toContain("should become public?");
    expect(control?.body.reply_markup).toBeDefined();
  });

  it("puts the buttons on the control message, so they can be stripped later", async () => {
    const draft = await withOriginals(2);
    // messageId is what removeKeyboard needs; the album has no keyboard to strip.
    expect(draft.preview?.messageId).toBe(4242);
    expect(draft.state).toBe("awaiting_approval");
  });

  it("uses the album path for a video even on its own", async () => {
    // sendPhoto cannot carry a video, and a video caption is capped lower still.
    await withOriginals(1, "video");
    expect(calls.map((c) => c.method)).toContain("sendMediaGroup");
    expect(calls.map((c) => c.method)).not.toContain("sendPhoto");
  });

  it("falls back to a plain message when there is no media", async () => {
    await awaitingApproval();
    expect(calls.map((c) => c.method)).toContain("sendMessage");
    expect(calls.map((c) => c.method)).not.toContain("sendPhoto");
  });
});

describe("publishing a draft with media", () => {
  const withMedia = async () => {
    const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "at the campus");
    const originals = [
      { mediaId: "media0", type: "image" as const, fileId: "file-0", key: `originals/${created.activityId}/media0.jpg` },
    ];
    return sendPreview(env(), { ...created, record: RECORD, originals });
  };

  beforeEach(async () => {
    await createManifest(content.bucket, emptyManifest());
  });

  it("hands the draft to Actions instead of publishing it", async () => {
    // The files still carry EXIF and GPS; nothing of them may become public
    // until a runner has stripped them (spec §10.2).
    const draft = await withMedia();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    expect(calls.map((c) => c.method)).toContain("dispatches");
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
  });

  it("moves to processing and records the job before dispatching", async () => {
    const draft = await withMedia();
    await handlePreviewCallback(press(draft, "p"), env());

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("processing");
    expect(stored?.job?.jobToken).toHaveLength(32);
    // The buttons go with the preview: nothing is left to decide.
    expect(stored?.preview).toBeNull();
  });

  it("sends Actions the draft id and the job token, and nothing else", async () => {
    // Workflow inputs show in the Actions UI, so anything passed is published.
    const draft = await withMedia();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    const dispatch = calls.find((c) => c.method === "dispatches");
    expect(Object.keys(dispatch?.body as object).sort()).toEqual(["inputs", "ref"]);
    expect(Object.keys(dispatch?.body.inputs as object).sort()).toEqual(["draftId", "jobToken"]);
    const body = JSON.stringify(dispatch?.body);
    expect(body).not.toContain("at the campus");
  });

  it("tells the author the media is being processed", async () => {
    const draft = await withMedia();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toContain("Processing the media");
  });

  it("fails the draft when GitHub refuses, rather than stranding it in processing", async () => {
    // Nothing is running and nothing ever will be: no workflow started, so no
    // workflow can report this. Left in `processing` the draft would have no
    // job and no buttons, after the author was promised a link.
    const draft = await withMedia();
    refuseDispatch();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("failed");
    // The buttons the failure message drew, so a retry can be recognised as one.
    expect(stored?.preview?.token).toHaveLength(12);

    const message = calls.find((c) => c.method === "sendMessage");
    expect(message?.body.text).toContain("Publication failed");
    expect(buttonsOn(message)).toEqual(["Retry", "Cancel"]);
  });

  it("still publishes a text-only draft directly", async () => {
    const draft = await awaitingApproval();
    await handlePreviewCallback(press(draft, "p"), env());

    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(1);
    expect(calls.map((c) => c.method)).not.toContain("dispatches");
  });
});

/**
 * The second pass through `awaiting_approval`: the media pipeline has already
 * run, the transcode changed the clip visibly, and the author is looking at the
 * result. Only the press is left.
 */
describe("confirming a processed video (spec Phase 6)", () => {
  const MEDIA_BASE = "https://media.example";

  const confirming = async (): Promise<Draft> => {
    const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "a run");
    const base = `${MEDIA_BASE}/media/activity-${created.activityId}`;
    const draft: Draft = {
      ...created,
      record: { ...RECORD, media: [{ mediaId: "media0", alt: "Along the river", caption: "Eight easy km" }] },
      originals: [
        { mediaId: "media0", type: "video", fileId: "file-0", key: `originals/${created.activityId}/media0.mov` },
      ],
      job: { jobToken: "job-token-0123456789abcdef", dispatchedAt: new Date().toISOString() },
      processed: {
        media: [
          {
            sourceId: "media0",
            type: "video",
            src: `${base}/media0-1920.mp4`,
            poster: `${base}/media0-poster-1600.webp`,
            thumbnail: `${base}/media0-poster-320.webp`,
            visibleChanges: ["scaled from 3840x2160 to 1920x1080"],
          },
        ],
        at: new Date().toISOString(),
      },
    };
    // sendPreview is what puts a live token on it, the same way the callback does.
    return sendPreview(env(), draft);
  };

  beforeEach(async () => {
    await createManifest(content.bucket, emptyManifest());
    // What the pipeline uploaded before anyone was asked about it, plus one
    // object belonging to a different activity.
    media.objects.set("media/activity-elsewhere00/other-800.webp", "not ours");
  });

  it("publishes from the files the pipeline produced, without dispatching again", async () => {
    const draft = await confirming();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    expect(calls.map((c) => c.method)).not.toContain("dispatches");
    const manifest = (await readManifest(content.bucket))!.manifest;
    expect(manifest.totalRecords).toBe(1);

    const chunk = JSON.parse(content.objects.get(chunkKey(manifest.latest!)) as unknown as string);
    expect(chunk[0].media[0]).toMatchObject({
      type: "video",
      src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1920.mp4`,
      poster: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-poster-1600.webp`,
      // The author's approved words, taken from the draft rather than the pipeline.
      alt: "Along the river",
      caption: "Eight easy km",
    });
  });

  it("retires the draft and sends the link", async () => {
    const draft = await confirming();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "p"), env());

    const stored = await loadDraft(storage.bucket, draft.draftId);
    expect(stored?.state).toBe("published");
    expect(stored?.preview).toBeNull();
    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toBe(
      "Published. https://site.example/activities/?v=morning-run-by-the-river",
    );
    // And the buttons come off the message that was answered.
    expect(calls.map((c) => c.method)).toContain("editMessageReplyMarkup");
  });

  it("publishes once however often the button is pressed", async () => {
    const draft = await confirming();
    await handlePreviewCallback(press(draft, "p"), env());
    await handlePreviewCallback(press(draft, "p"), env());

    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(1);
    expect(answers()).toContain("Already published.");
  });

  it("refuses a press from the preview the confirmation replaced", async () => {
    const draft = await confirming();
    await handlePreviewCallback(press(draft, "p", "an-older-token"), env());

    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
    expect(answers()).toContain("This preview has been replaced. Use the newest one.");
  });

  it("removes the uploaded derivatives when the author cancels", async () => {
    // Nothing references them — no record, no manifest entry — but unreachable
    // is not gone, and the author has just declined them.
    const draft = await confirming();
    const prefix = `media/activity-${draft.activityId}/`;
    media.objects.set(`${prefix}media0-1920.mp4`, "mp4 bytes");
    media.objects.set(`${prefix}media0-poster-1600.webp`, "poster bytes");
    media.objects.set(`${prefix}media0-poster-320.webp`, "thumb bytes");

    await handlePreviewCallback(press(draft, "c"), env());

    expect([...media.objects.keys()]).toEqual(["media/activity-elsewhere00/other-800.webp"]);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("cancelled");
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
  });

  it("touches no media when a draft is cancelled before anything was processed", async () => {
    const draft = await awaitingApproval();
    media.objects.set(`media/activity-${draft.activityId}/media0-1920.mp4`, "should not exist, but prove it");

    await handlePreviewCallback(press(draft, "c"), env());

    expect(media.objects.size).toBe(2);
  });
});

/**
 * `processing → failed → retry → processing` (spec §22–23).
 *
 * A failed draft is the only state other than `awaiting_approval` that still has
 * live buttons, and it has exactly two: run it again, or give up. Everything here
 * turns on the same promise — nothing public changed, so a retry is free to
 * repeat whatever the first attempt did.
 */
describe("retrying a failed publication (spec §23)", () => {
  const MEDIA_BASE = "https://media.example";

  beforeEach(async () => {
    await createManifest(content.bucket, emptyManifest());
  });

  /** A media draft whose dispatch GitHub refused: the shortest real route into `failed`. */
  async function failed(): Promise<Draft> {
    const created = await createDraft(storage.bucket, { chatId: 99, senderId: 42, messageId: 7 }, "at the campus");
    const draft = await sendPreview(env(), {
      ...created,
      record: RECORD,
      originals: [
        { mediaId: "media0", type: "image", fileId: "file-0", key: `originals/${created.activityId}/media0.jpg` },
      ],
    });

    refuseDispatch();
    await handlePreviewCallback(press(draft, "p"), env());
    refuseDispatch(false);

    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.state).toBe("failed");
    return stored;
  }

  /** A draft whose media was sanitised and uploaded, and whose publication then failed. */
  async function failedAfterUpload(): Promise<Draft> {
    const draft = await failed();
    const base = `${MEDIA_BASE}/media/activity-${draft.activityId}`;
    const withProcessed: Draft = {
      ...draft,
      record: { ...RECORD, media: [{ mediaId: "media0", alt: "A cup", caption: "The first" }] },
      processed: {
        media: [
          {
            sourceId: "media0",
            type: "image",
            src: `${base}/media0-1600.webp`,
            thumbnail: `${base}/media0-320.webp`,
            visibleChanges: [],
          },
        ],
        at: new Date().toISOString(),
      },
    };
    await saveDraft(storage.bucket, withProcessed);
    return withProcessed;
  }

  it("offers Retry and Cancel, and nothing that would re-ask an answered question", async () => {
    // The text was approved before any of this started; what broke was the
    // publishing, and "Regenerate" is not an answer to that.
    const draft = await failed();
    const message = calls.filter((c) => c.method === "sendMessage").pop();

    expect(buttonsOn(message)).toEqual(["Retry", "Cancel"]);
    expect(draft.preview?.token).toHaveLength(12);
  });

  it("names the stage that stopped, so the message says what did not happen", async () => {
    await failed();
    const text = calls.filter((c) => c.method === "sendMessage").pop()?.body.text as string;

    expect(text).toContain("Publication failed.");
    expect(text).toContain("The processing job could not be started");
    // Never a log line, a URL, or the author's own words.
    expect(text).not.toContain("at the campus");
    expect(text).not.toContain("403");
  });

  it("dispatches the same draft again with a fresh job token", async () => {
    // The activity id is what every derivative's name is built from, so reusing
    // it overwrites whatever the first attempt half-wrote.
    const draft = await failed();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    const dispatch = calls.find((c) => c.method === "dispatches");
    expect((dispatch?.body.inputs as { draftId: string }).draftId).toBe(draft.draftId);

    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.state).toBe("processing");
    expect(stored.activityId).toBe(draft.activityId);
    expect(stored.job?.jobToken).toHaveLength(32);
    // Fresh, so a straggler from the first attempt cannot report against this one.
    expect(stored.job?.jobToken).not.toBe(draft.job?.jobToken);
  });

  it("answers the button before the dispatch, so it stops spinning", async () => {
    const draft = await failed();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    expect(calls[0]?.method).toBe("answerCallbackQuery");
    expect(answers()).toContain("Trying again…");
  });

  it("publishes from the files already uploaded rather than sanitising them twice", async () => {
    const draft = await failedAfterUpload();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    expect(calls.map((c) => c.method)).not.toContain("dispatches");
    const manifest = (await readManifest(content.bucket))!.manifest;
    expect(manifest.totalRecords).toBe(1);

    const chunk = JSON.parse(content.objects.get(chunkKey(manifest.latest!)) as unknown as string);
    expect(chunk[0].media[0]).toMatchObject({
      src: `${MEDIA_BASE}/media/activity-${draft.activityId}/media0-1600.webp`,
      alt: "A cup",
    });
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("published");
  });

  it("goes back to failed with new buttons when the retry fails too", async () => {
    const draft = await failedAfterUpload();
    // No manifest to publish against, which is how publishRecord refuses.
    content.objects.set("content/manifest.json", "not json");
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    const stored = (await loadDraft(storage.bucket, draft.draftId))!;
    expect(stored.state).toBe("failed");
    expect(stored.preview?.token).not.toBe(draft.preview?.token);

    const message = calls.filter((c) => c.method === "sendMessage").pop();
    expect(buttonsOn(message)).toEqual(["Retry", "Cancel"]);
  });

  it("refuses the buttons under a superseded failure", async () => {
    // The same draft can fail twice; only the newest message may act on it.
    const first = await failedAfterUpload();
    content.objects.set("content/manifest.json", "not json");
    await handlePreviewCallback(press(first, "t"), env());
    calls.length = 0;

    await handlePreviewCallback(press(first, "t"), env());

    expect(answers()).toEqual(["This preview has been replaced. Use the newest one."]);
  });

  it("runs the job once however often Retry is pressed", async () => {
    const draft = await failed();
    await handlePreviewCallback(press(draft, "t"), env());
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    expect(calls.map((c) => c.method)).not.toContain("dispatches");
    expect(answers()).toEqual(["Already processing."]);
  });

  it("hands back the link instead of publishing twice if the draft is already live", async () => {
    const draft = await failedAfterUpload();
    await saveDraft(storage.bucket, {
      ...draft,
      published: { recordId: "rec-1", url: "https://site.example/#activity" },
    });
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
    expect(calls.find((c) => c.method === "sendMessage")?.body.text).toContain("Already published.");
  });

  it("refuses everything the failure keyboard does not offer", async () => {
    // Those buttons only exist on a preview that is no longer on screen, so a
    // press can only have come from a superseded message.
    const draft = await failed();

    for (const code of ["p", "e", "r", "m"]) {
      calls.length = 0;
      await handlePreviewCallback(press(draft, code), env());
      expect(answers()).toEqual(["Already failed."]);
    }

    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
  });

  it("cancels a failed draft and sweeps whatever the run had already uploaded", async () => {
    // A run that stopped after the upload step left a complete set behind; one
    // that stopped during it left part of a set. Neither is referenced.
    const draft = await failed();
    const prefix = `media/activity-${draft.activityId}/`;
    media.objects.set(`${prefix}media0-1600.webp`, "webp bytes");
    media.objects.set(`${prefix}media0-320.webp`, "thumb bytes");
    media.objects.set("media/activity-elsewhere00/other-800.webp", "not ours");

    await handlePreviewCallback(press(draft, "c"), env());

    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("cancelled");
    expect([...media.objects.keys()]).toEqual(["media/activity-elsewhere00/other-800.webp"]);
  });

  it("says so when the draft has expired out from under the buttons", async () => {
    // The bucket's seven-day rule removes drafts, and the failure message with
    // its buttons stays in the chat long after.
    const draft = await failed();
    await storage.bucket.delete(`drafts/${draft.draftId}/draft.json`);
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    expect(answers()).toEqual(["This draft is no longer available."]);
    expect(calls.map((c) => c.method)).not.toContain("dispatches");
  });
});

describe("Retry outside a failure", () => {
  it("does nothing to a draft still awaiting approval", async () => {
    // The button is drawn nowhere but the failure message, so this press is
    // hand-made. Acting on it would publish, which is not what "Retry" says.
    await createManifest(content.bucket, emptyManifest());
    const draft = await awaitingApproval();
    calls.length = 0;

    await handlePreviewCallback(press(draft, "t"), env());

    expect(answers()).toEqual(["Not available yet."]);
    expect((await readManifest(content.bucket))?.manifest.totalRecords).toBe(0);
    expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("awaiting_approval");
  });
});
