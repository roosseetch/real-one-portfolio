/**
 * The webhook route at HTTP altitude: what status a caller actually gets.
 *
 * The status codes are the contract with Telegram, not an implementation
 * detail — Telegram redelivers on non-2xx and throttles a webhook that keeps
 * failing — so they are asserted here separately from the authorization logic
 * in telegram/webhook.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index";
import type { TelegramUpdate } from "./telegram/types";
import { aiRecord, createFakeAi } from "./test-support/ai";
import { createFakeBucket, type FakeBucket } from "./test-support/r2";

const SECRET = "test-webhook-secret";
const ALLOWED_ID = 4242;
const WEBHOOK_URL = "https://worker.example/telegram/webhook";

let storage: FakeBucket;

beforeEach(() => {
  storage = createFakeBucket();
  // Nothing on this path should reach the network; if something tries, the
  // test fails loudly rather than hanging on a real request.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function testEnv(overrides: Partial<Env> = {}): Env {
  // What the webhook route actually touches: the two secrets the gate reads,
  // the bucket an authorized message is written to, and the model it is handed
  // to afterwards.
  return {
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_ALLOWED_USER_IDS: String(ALLOWED_ID),
    PRIVATE_BUCKET: storage.bucket,
    AI: createFakeAi(aiRecord()).AI,
    TELEGRAM_BOT_TOKEN: "test-token",
    ...overrides,
  } as Env;
}

/** `secret: null` omits the header entirely, which is not the same as sending an empty one. */
function webhookRequest(body: unknown, secret: string | null = SECRET) {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function messageFrom(id: number): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 10, date: 1_700_000_000, chat: { id: 99, type: "private" }, from: { id }, text: "hi" },
  };
}

describe("POST /telegram/webhook", () => {
  it("rejects a request with no secret header", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), null), testEnv());
    expect(response.status).toBe(401);
  });

  it("rejects the wrong secret", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), "wrong"), testEnv());
    expect(response.status).toBe(401);
  });

  it("rejects a secret that is only a prefix of the real one", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), SECRET.slice(0, -1)), testEnv());
    expect(response.status).toBe(401);
  });

  it("rejects everything when the secret is not configured", async () => {
    const env = testEnv({ TELEGRAM_WEBHOOK_SECRET: undefined });
    expect((await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), ""), env)).status).toBe(401);
    expect((await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), env)).status).toBe(401);
  });

  it("does not advertise an authentication scheme", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), "wrong"), testEnv());
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("accepts an allowlisted sender and stores the draft", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), testEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect([...storage.objects.keys()]).toEqual([expect.stringMatching(/^drafts\/[0-9a-z]{16}\/draft\.json$/)]);
  });

  // Every case below answers 200 on purpose. A non-2xx would have Telegram
  // redelivering a decision we have already made, with escalating backoff,
  // until it throttles the webhook.
  it("ignores a sender who is not on the allowlist", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID + 1)), testEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    // The half of "ignored" that matters: nothing was written.
    expect(storage.objects.size).toBe(0);
  });

  it("ignores everyone when the allowlist is empty", async () => {
    const env = testEnv({ TELEGRAM_ALLOWED_USER_IDS: "" });
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), env);
    expect(response.status).toBe(200);
    expect(storage.objects.size).toBe(0);
  });

  it("ignores a body that is not JSON", async () => {
    const response = await worker.fetch(webhookRequest("{not json"), testEnv());
    expect(response.status).toBe(200);
    expect(storage.objects.size).toBe(0);
  });

  it("writes nothing when the secret is wrong", async () => {
    await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), "wrong"), testEnv());
    expect(storage.objects.size).toBe(0);
  });

  it("asks Telegram to redeliver when storage fails", async () => {
    // The one place a retry is worth having: the decision was fine, the write
    // was not. Everything above this point would decide the same way again.
    storage.failNextPut();
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), testEnv());
    expect(response.status).toBe(503);
    expect(storage.objects.size).toBe(0);
  });

  it("ignores an update carrying no sender", async () => {
    const channelPost = {
      update_id: 2,
      message: { message_id: 11, date: 1_700_000_000, chat: { id: 99, type: "channel" }, text: "hi" },
    };
    const response = await worker.fetch(webhookRequest(channelPost), testEnv());
    expect(response.status).toBe(200);
  });
});

describe("routing", () => {
  it("does not answer GET on the webhook path", async () => {
    const response = await worker.fetch(new Request(WEBHOOK_URL), testEnv());
    expect(response.status).toBe(404);
  });

  it("says nothing useful about unknown paths", async () => {
    const response = await worker.fetch(new Request("https://worker.example/", { method: "POST" }), testEnv());
    expect(response.status).toBe(404);
  });
});
