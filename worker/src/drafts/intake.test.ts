import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiRecord, createFakeAi, type AiStep } from "../test-support/ai";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramUpdate } from "../telegram/types";
import { intakeUpdate } from "./intake";
import { loadDraft } from "./store";

const SENDER = 4242;
const AI_UNAVAILABLE = "The draft has been saved. AI processing can continue later.";

let storage: FakeBucket;
let sent: string[];

beforeEach(() => {
  storage = createFakeBucket();
  sent = [];
  // Records what the author would have been told, without reaching Telegram.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)).text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
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

  it("leaves the draft awaiting nothing yet", async () => {
    // There is nothing to approve until the preview has been sent, so the
    // draft does not reach awaiting_approval here.
    const result = await intakeUpdate(textMessage("an easy 8k"), SENDER, env());

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.state).toBe("draft");
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

  it("does not reply when generation worked", async () => {
    await intakeUpdate(textMessage("an easy 8k"), SENDER, env());
    expect(sent).toEqual([]);
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
