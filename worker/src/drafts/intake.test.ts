import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiRecord, createFakeAi, type AiStep } from "../test-support/ai";
import { bodyFor, type SampleFormat } from "../test-support/bytes";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramMessage, TelegramUpdate } from "../telegram/types";
import { intakeUpdate } from "./intake";
import { setPendingEdit } from "./pending";
import { loadDraft, saveDraft } from "./store";

const SENDER = 4242;
const AI_UNAVAILABLE = "The draft has been saved. AI processing can continue later.";

let storage: FakeBucket;
let content: FakeBucket;
let sent: string[];
let keyboards: unknown[];

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  sent = [];
  keyboards = [];
  // Records what the author would have been shown, without reaching Telegram.
  // The message_id matters: without one, sendPreview treats the send as failed
  // and leaves the draft untouched, which would let these tests pass for the
  // wrong reason.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.text !== undefined) sent.push(body.text);
    if (body.reply_markup !== undefined) keyboards.push(body.reply_markup);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The same recording mock, with a download that actually serves bytes.
 *
 * The default `getFile` above returns no `file_path`, so `storeOriginal` gives
 * up before fetching anything — which is what every other test here wants. The
 * contents check has nothing to read under that, so the cases about what the
 * bytes turn out to be need a file to arrive.
 */
function servingFile(format: SampleFormat) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/getFile")) {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: "documents/file_9.webp", file_size: 2048 } }),
      );
    }

    // The download itself carries no body; everything else is a Bot API call.
    if (init?.body === undefined) return new Response(bodyFor(format), { status: 200 });

    const body = JSON.parse(String(init.body));
    if (body.text !== undefined) sent.push(body.text);
    if (body.caption !== undefined) sent.push(body.caption);
    if (body.reply_markup !== undefined) keyboards.push(body.reply_markup);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
}

function env(...steps: AiStep[]) {
  return {
    PRIVATE_BUCKET: storage.bucket,
    AI: createFakeAi(...(steps.length > 0 ? steps : [aiRecord()])).AI,
    TELEGRAM_BOT_TOKEN: "test-token",
    CONTENT_BUCKET: content.bucket,
    MEDIA_BUCKET: createFakeBucket().bucket,
    SITE_BASE_URL: "https://site.example",
    GITHUB_REPOSITORY: "owner/repo",
    MEDIA_WORKFLOW_FILE: "process-media.yml",
    GITHUB_DISPATCH_TOKEN: "dispatch-token",
  };
}

function textMessage(text: string | undefined): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: 99, type: "private" },
      from: { id: SENDER },
      ...(text === undefined ? {} : { text }),
    },
  };
}

describe("intakeUpdate", () => {
  it("stores a draft carrying the generated record", async () => {
    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.record?.title).toBe("Morning run by the river");
    expect(await loadDraft(storage.bucket, result.draft.draftId)).toEqual(result.draft);
  });

  it("reaches awaiting_approval only once the preview is on screen", async () => {
    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.state).toBe("awaiting_approval");
    expect(result.draft.preview).toEqual({ messageId: 4242, token: expect.any(String) });
  });

  it("stays in draft when the preview could not be delivered", async () => {
    // Nothing was shown, so nothing is awaiting approval.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.state).toBe("draft");
    expect(result.draft.preview).toBeNull();
  });

  it("records where the message came from so the preview can be sent back", async () => {
    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.source).toEqual({ chatId: 99, senderId: SENDER, messageId: 7 });
  });

  it("keeps the draft and says so when the AI allowance is exhausted", async () => {
    // Spec §23: the words matter, because this is what the author reads.
    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env(new Error("daily quota exceeded")));

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.record).toBeNull();
    expect(sent).toEqual([AI_UNAVAILABLE]);
    expect(await loadDraft(storage.bucket, result.draft.draftId)).not.toBeNull();
  });

  it("keeps the draft when the model only ever returns unusable output", async () => {
    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env({ response: "{not json" }));

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.record).toBeNull();
    expect(sent).toEqual([AI_UNAVAILABLE]);
  });

  it("propagates a failure to create the draft at all", async () => {
    // Nothing has been written yet, so letting this reach the webhook as a 503
    // is safe: Telegram redelivers and the author loses nothing.
    storage.failNextPut();

    await expect(intakeUpdate(textMessage("an easy 8k"), SENDER, env())).rejects.toThrow("R2 unavailable");
    expect(storage.objects.size).toBe(0);
  });

  it("swallows a failure to store the generated record", async () => {
    // The opposite case. The draft already exists, so throwing would answer 503
    // and Telegram would redeliver the message into a second draft for the same
    // thought. Losing the record costs a regeneration; a duplicate costs trust.
    const original = storage.bucket.put.bind(storage.bucket);
    let puts = 0;
    vi.spyOn(storage.bucket, "put").mockImplementation(((...args: Parameters<typeof original>) => {
      if (++puts === 2) return Promise.reject(new Error("R2 unavailable"));
      return original(...args);
    }) as typeof original);

    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());

    expect(result.status).toBe("created");
    expect(sent).toEqual([AI_UNAVAILABLE]);
    // The draft written by the first put survived.
    expect(storage.objects.size).toBe(1);
  });

  it("sends the preview with its buttons when generation worked", async () => {
    await intakeUpdate(textMessage("an easy 8k"), SENDER, env());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Is this the information and media that should become public?");
    expect(sent[0]).toContain("Morning run by the river");
    expect(keyboards).toHaveLength(1);
  });
});

describe("a message that answers an Edit prompt", () => {
  it("revises the existing draft instead of starting a new one", async () => {
    const first = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());
    if (first.status !== "created") throw new Error("expected a draft");
    await setPendingEdit(storage.bucket, 99, first.draft.draftId);
    sent.length = 0;

    const result = await intakeUpdate(
      textMessage("call it an evening run"),
      SENDER,
      env(aiRecord({ title: "Evening run by the river" })),
    );

    expect(result.status).toBe("created");
    // One draft, not two.
    expect([...storage.objects.keys()].filter((k) => k.endsWith("draft.json"))).toHaveLength(1);
    expect((await loadDraft(storage.bucket, first.draft.draftId))?.record?.title).toBe("Evening run by the river");
  });

  it("shows the complete entry again rather than the changed field", async () => {
    // Spec §7.3 is explicit: approving a diff is not approving what becomes public.
    const first = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());
    if (first.status !== "created") throw new Error("expected a draft");
    await setPendingEdit(storage.bucket, 99, first.draft.draftId);
    sent.length = 0;

    await intakeUpdate(textMessage("call it an evening run"), SENDER, env());

    expect(sent.at(-1)).toContain("Is this the information and media that should become public?");
    for (const label of ["Title", "Date", "Summary", "Body", "Tags"]) expect(sent.at(-1)).toContain(label);
  });

  it("starts a new draft when the one being edited has moved on", async () => {
    // Cancelled while the author was typing. Treating the message as an
    // instruction would silently discard it.
    const first = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());
    if (first.status !== "created") throw new Error("expected a draft");
    await saveDraft(storage.bucket, { ...first.draft, state: "cancelled" });
    await setPendingEdit(storage.bucket, 99, first.draft.draftId);

    await intakeUpdate(textMessage("a completely new thought"), SENDER, env());

    expect([...storage.objects.keys()].filter((k) => k.endsWith("draft.json"))).toHaveLength(2);
  });

  it("starts a new draft once the pointer has expired", async () => {
    const first = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());
    if (first.status !== "created") throw new Error("expected a draft");
    await setPendingEdit(storage.bucket, 99, first.draft.draftId, new Date("2020-01-01T00:00:00.000Z"));

    await intakeUpdate(textMessage("a completely new thought"), SENDER, env());

    expect([...storage.objects.keys()].filter((k) => k.endsWith("draft.json"))).toHaveLength(2);
  });
});

describe("updates that do not start a draft", () => {
  it("ignores a message with no text at all", async () => {
    expect((await intakeUpdate(textMessage(undefined), SENDER, env())).status).toBe("unsupported");
    expect(storage.objects.size).toBe(0);
  });

  it("ignores a message that is only whitespace", async () => {
    expect((await intakeUpdate(textMessage("   \n  "), SENDER, env())).status).toBe("unsupported");
    expect(storage.objects.size).toBe(0);
  });

  it("does not start a second draft when a message is edited in Telegram", async () => {
    // Someone fixing a typo would otherwise end up with two drafts for one
    // thought. Editing a draft is the preview buttons' job, not this one's.
    const update: TelegramUpdate = { update_id: 2, edited_message: textMessage("an easy 8k").message };

    expect((await intakeUpdate(update, SENDER, env())).status).toBe("unsupported");
    expect(storage.objects.size).toBe(0);
  });

  it("ignores a button press", async () => {
    const update: TelegramUpdate = {
      update_id: 3,
      callback_query: { id: "cb", from: { id: SENDER }, data: "publish" },
    };

    expect((await intakeUpdate(update, SENDER, env())).status).toBe("unsupported");
    expect(storage.objects.size).toBe(0);
  });

  it("trims the incoming text before it reaches the model", async () => {
    const result = await intakeUpdate(textMessage("  an easy 8k \n"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.input.text).toBe("an easy 8k");
  });
});

/**
 * A picture sent as a file arrives as a document, never as a photo — Telegram
 * does it unprompted with .webp. This used to match no branch: the caption sits
 * in `caption` rather than `text`, so the message fell through to the text path,
 * came out empty, and was answered 200 with nothing said.
 */
describe("a picture sent as a file", () => {
  function documentMessage(mime: string | undefined, caption?: string): TelegramUpdate {
    return {
      update_id: 5,
      message: {
        message_id: 8,
        date: 1_700_000_000,
        chat: { id: 99, type: "private" },
        from: { id: SENDER },
        ...(caption === undefined ? {} : { caption }),
        document: {
          file_id: "doc",
          file_unique_id: "u9",
          file_name: "Image_20260806_114203.webp",
          ...(mime === undefined ? {} : { mime_type: mime }),
          file_size: 616_000,
        },
      },
    };
  }

  it("becomes a draft, taking the caption as its text", async () => {
    const result = await intakeUpdate(
      documentMessage("image/webp", "The books that I like, and what do you read?"),
      SENDER,
      env(),
    );

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.input.text).toBe("The books that I like, and what do you read?");
    expect(result.draft.record?.title).toBe("Morning run by the river");
  });

  it("is previewed, so the author sees something back", async () => {
    await intakeUpdate(documentMessage("image/webp", "a caption"), SENDER, env());
    expect(sent.length).toBeGreaterThan(0);
    expect(keyboards.length).toBeGreaterThan(0);
  });

  // The message that was reported. Telegram omits the type when the sending
  // client cannot name it, and the old check read that silence as "not media".
  it("becomes a draft even when Telegram sent no mime type at all", async () => {
    const result = await intakeUpdate(documentMessage(undefined, "no type on this one"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.input.text).toBe("no type on this one");
  });

  it("becomes a draft when Telegram could only call it application/octet-stream", async () => {
    const result = await intakeUpdate(documentMessage("application/octet-stream", "still a picture"), SENDER, env());

    expect(result.status).toBe("created");
  });

  it("says so when the file is not an image or a video", async () => {
    const result = await intakeUpdate(documentMessage("application/pdf", "read this"), SENDER, env());

    expect(result.status).toBe("unsupported");
    expect(sent.join(" ")).toContain("I can only publish images and videos");
    // Declining must not leave a half-made draft behind.
    expect(storage.objects.size).toBe(0);
  });

  // The reply named nothing the first time this happened, and a decline answers
  // 200, which the error log does not persist — so neither the chat nor R2
  // recorded what had been refused.
  it("quotes what Telegram called the file, so the next refusal is readable from the chat", async () => {
    await intakeUpdate(documentMessage("application/pdf"), SENDER, env());

    expect(sent.join(" ")).toContain("application/pdf");
    expect(sent.join(" ")).toContain("Image_20260806_114203.webp");
  });

  // Accepted today, then handed to a sanitiser with no decoder for it, where
  // the run fails and nothing tells the author anything.
  it("refuses a HEIC by name rather than stranding it in the pipeline", async () => {
    const result = await intakeUpdate(documentMessage("image/heic"), SENDER, env());

    expect(result.status).toBe("unsupported");
    expect(sent.join(" ")).toContain("HEIC");
    expect(sent.join(" ")).toContain("JPEG");
    expect(storage.objects.size).toBe(0);
  });
});

/**
 * Telegram turns a `.webp` upload into a sticker on its own, so this is the same
 * picture the author meant to send, arriving under a field nothing used to read.
 */
describe("a picture Telegram called a sticker", () => {
  function stickerMessage(
    overrides: Partial<NonNullable<TelegramMessage["sticker"]>> = {},
    caption?: string,
  ): TelegramUpdate {
    return {
      update_id: 9,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 99, type: "private" },
        from: { id: SENDER },
        ...(caption === undefined ? {} : { caption }),
        sticker: {
          file_id: "stick",
          file_unique_id: "u7",
          is_animated: false,
          is_video: false,
          width: 512,
          height: 512,
          file_size: 24_000,
          ...overrides,
        },
      },
    };
  }

  it("becomes a draft rather than an unanswered message", async () => {
    const result = await intakeUpdate(stickerMessage({}, "from the trip"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.input.text).toBe("from the trip");
  });

  it("says an animated sticker moves, rather than that it found nothing to publish", async () => {
    const result = await intakeUpdate(stickerMessage({ is_animated: true }), SENDER, env());

    expect(result.status).toBe("unsupported");
    expect(sent.join(" ")).toContain("animated sticker");
    expect(sent.join(" ")).not.toContain("could not find anything to publish");
    expect(storage.objects.size).toBe(0);
  });

  it("says the same of a video sticker", async () => {
    await intakeUpdate(stickerMessage({ is_video: true }), SENDER, env());

    expect(sent.join(" ")).toContain("video sticker");
  });
});

/**
 * The last tier: the name got the file this far and the bytes disagree. The
 * draft is already made by then, so a refusal here has to cost the file without
 * costing the message it arrived with.
 */
describe("a file whose contents are not what its name said", () => {
  function documentMessage(caption?: string): TelegramUpdate {
    return {
      update_id: 12,
      message: {
        message_id: 13,
        date: 1_700_000_000,
        chat: { id: 99, type: "private" },
        from: { id: SENDER },
        ...(caption === undefined ? {} : { caption }),
        document: {
          file_id: "doc",
          file_unique_id: "u9",
          file_name: "invoice.webp",
          mime_type: "image/webp",
          file_size: 616_000,
        },
      },
    };
  }

  it("stores the original when the bytes agree with the name", async () => {
    servingFile("webp");

    const result = await intakeUpdate(documentMessage("the good one"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.originals).toHaveLength(1);
    expect([...storage.objects.keys()]).toContainEqual(expect.stringMatching(/^originals\//));
  });

  it("keeps the author's words and tells them which file went", async () => {
    servingFile("pdf");

    const result = await intakeUpdate(documentMessage("worth keeping anyway"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.originals).toHaveLength(0);
    expect(result.draft.input.text).toBe("worth keeping anyway");
    expect(sent.join(" ")).toContain("its contents are a PDF");
    expect(sent.join(" ")).toContain("invoice.webp");
  });

  it("writes nothing to the private bucket beyond the draft itself", async () => {
    servingFile("pdf");

    await intakeUpdate(documentMessage("worth keeping anyway"), SENDER, env());

    expect([...storage.objects.keys()].every((k) => k.startsWith("drafts/"))).toBe(true);
  });

  // Nothing to approve: the one file was refused and there were no words. A
  // preview here would ask the author to publish an empty record.
  it("does not preview an empty draft when the file was all there was", async () => {
    servingFile("pdf");

    const result = await intakeUpdate(documentMessage(), SENDER, env());

    expect(result.status).toBe("unsupported");
    expect(sent.join(" ")).toContain("its contents are");
    expect(keyboards).toEqual([]);
  });
});

/**
 * The same silence, one layer earlier and far more common: Telegram will not
 * hand a bot a file over 20 MB, which nearly every phone video exceeds. The
 * refusal used to be folded into "could not fetch it", so the author was told
 * nothing at all and the draft simply went quiet.
 */
describe("a video Telegram will not hand over", () => {
  function videoMessage(fileSize: number, caption?: string): TelegramUpdate {
    return {
      update_id: 14,
      message: {
        message_id: 15,
        date: 1_700_000_000,
        chat: { id: 99, type: "private" },
        from: { id: SENDER },
        ...(caption === undefined ? {} : { caption }),
        video: {
          file_id: "vid",
          file_unique_id: "u10",
          width: 1080,
          height: 1920,
          duration: 31,
          file_size: fileSize,
        },
      },
    };
  }

  it("names the size and the limit rather than going quiet", async () => {
    const result = await intakeUpdate(videoMessage(31_457_280), SENDER, env());

    expect(result.status).toBe("unsupported");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("30.0 MB");
    expect(sent[0]).toContain("20.0 MB");
    // Nothing to approve: the video was the whole message.
    expect(keyboards).toEqual([]);
  });

  it("keeps the caption and previews it, when there was one", async () => {
    const result = await intakeUpdate(videoMessage(31_457_280, "the run itself"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.originals).toHaveLength(0);
    expect(result.draft.input.text).toBe("the run itself");
    expect(sent.join(" ")).toContain("20.0 MB");
  });

  it("writes nothing to the private bucket beyond the draft itself", async () => {
    await intakeUpdate(videoMessage(31_457_280, "the run itself"), SENDER, env());

    expect([...storage.objects.keys()].every((k) => k.startsWith("drafts/"))).toBe(true);
  });
});

/**
 * The failure that made this worth fixing: a message the intake could not use
 * was answered 200 and dropped, which from the author's side is
 * indistinguishable from a bot that has died.
 */
describe("messages the intake cannot use", () => {
  it("answers a message carrying neither text nor media", async () => {
    const result = await intakeUpdate(textMessage(undefined), SENDER, env());

    expect(result.status).toBe("unsupported");
    expect(sent.join(" ")).toContain("could not find anything to publish");
    expect(storage.objects.size).toBe(0);
  });

  it("answers whitespace rather than treating it as a note", async () => {
    await intakeUpdate(textMessage("   \n  "), SENDER, env());
    expect(sent.join(" ")).toContain("could not find anything to publish");
  });

  it("stays quiet for an update with no message to answer", async () => {
    // An edited_message has a chat, but replying would be answering a typo fix.
    // A button press has no message of its own at all.
    const update: TelegramUpdate = {
      update_id: 6,
      callback_query: { id: "cb", from: { id: SENDER }, data: "publish" },
    };

    expect((await intakeUpdate(update, SENDER, env())).status).toBe("unsupported");
    expect(sent).toEqual([]);
  });
});
