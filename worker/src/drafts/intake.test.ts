import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiRecord, createFakeAi, type AiStep } from "../test-support/ai";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramUpdate } from "../telegram/types";
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

function env(...steps: AiStep[]) {
  return {
    PRIVATE_BUCKET: storage.bucket,
    AI: createFakeAi(...(steps.length > 0 ? steps : [aiRecord()])).AI,
    TELEGRAM_BOT_TOKEN: "test-token",
    CONTENT_BUCKET: content.bucket,
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
