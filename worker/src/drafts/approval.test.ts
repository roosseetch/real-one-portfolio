import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiRecord, createFakeAi, type AiStep } from "../test-support/ai";
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
/** Every Telegram call, as {method, body}. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  storage = createFakeBucket();
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({
      method: String(url).split("/").pop() ?? "",
      body: JSON.parse(String(init?.body)),
    });
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

    expect(answers()).toEqual(["This preview has been replaced. Use the newest one."]);
  });

  it("acknowledges the buttons whose flows land later, without touching the draft", async () => {
    for (const code of ["p", "m"]) {
      const draft = await awaitingApproval();
      calls.length = 0;

      await handlePreviewCallback(press(draft, code), env());

      expect(answers()).toEqual(["Not available yet."]);
      // Still approvable: nothing was acted on, so the buttons stay live.
      expect((await loadDraft(storage.bucket, draft.draftId))?.state).toBe("awaiting_approval");
      expect(calls.map((c) => c.method)).not.toContain("editMessageReplyMarkup");
    }
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

  it("rewrites from the author's note, not from the last generation", async () => {
    // Regenerating from the previous output would compound its drift.
    const fake = createFakeAi(aiRecord());
    const draft = await awaitingApproval();

    await handlePreviewCallback(press(draft, "r"), {
      PRIVATE_BUCKET: storage.bucket,
      TELEGRAM_BOT_TOKEN: "t",
      AI: fake.AI,
    });

    const prompt = (fake.calls[0].input as { messages: Array<{ content: string }> }).messages.at(-1)?.content;
    expect(prompt).toContain("an easy 8k");
    expect(prompt).not.toContain("Morning run by the river");
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
