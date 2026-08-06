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

/** Runs deferred work inline, so a test sees the same result the runtime would. */
const ctx = (): ExecutionContext =>
  ({ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} }) as ExecutionContext;

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

/**
 * Everything the request wrote apart from its own error log. The two live in
 * the same bucket, so a test about drafts has to say which it means.
 */
const authored = () => [...storage.objects.keys()].filter((key) => !key.startsWith("logs/"));

const errorLogs = () => [...storage.objects.keys()].filter((key) => key.startsWith("logs/"));

function messageFrom(id: number): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 10, date: 1_700_000_000, chat: { id: 99, type: "private" }, from: { id }, text: "hi" },
  };
}

describe("POST /telegram/webhook", () => {
  it("rejects a request with no secret header", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), null), testEnv(), ctx());
    expect(response.status).toBe(401);
  });

  it("rejects the wrong secret", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), "wrong"), testEnv(), ctx());
    expect(response.status).toBe(401);
  });

  it("rejects a secret that is only a prefix of the real one", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), SECRET.slice(0, -1)), testEnv(), ctx());
    expect(response.status).toBe(401);
  });

  it("rejects everything when the secret is not configured", async () => {
    const env = testEnv({ TELEGRAM_WEBHOOK_SECRET: undefined });
    expect((await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), ""), env, ctx())).status).toBe(401);
    expect((await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), env, ctx())).status).toBe(401);
    expect(errorLogs()).toEqual([]);
  });

  it("does not advertise an authentication scheme", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), "wrong"), testEnv(), ctx());
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("accepts an allowlisted sender and stores the draft", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), testEnv(), ctx());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(authored()).toEqual([expect.stringMatching(/^drafts\/[0-9a-z]{16}\/draft\.json$/)]);
  });

  // Every case below answers 200 on purpose. A non-2xx would have Telegram
  // redelivering a decision we have already made, with escalating backoff,
  // until it throttles the webhook.
  it("ignores a sender who is not on the allowlist", async () => {
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID + 1)), testEnv(), ctx());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    // The half of "ignored" that matters: nothing was written.
    expect(storage.objects.size).toBe(0);
  });

  it("ignores everyone when the allowlist is empty", async () => {
    const env = testEnv({ TELEGRAM_ALLOWED_USER_IDS: "" });
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), env, ctx());
    expect(response.status).toBe(200);
    expect(storage.objects.size).toBe(0);
  });

  it("ignores a body that is not JSON", async () => {
    const response = await worker.fetch(webhookRequest("{not json"), testEnv(), ctx());
    expect(response.status).toBe(200);
    expect(storage.objects.size).toBe(0);
  });

  it("writes nothing when the secret is wrong", async () => {
    await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID), "wrong"), testEnv(), ctx());
    expect(storage.objects.size).toBe(0);
  });

  it("routes a button press without treating it as a new message", async () => {
    // A callback carries no text, so the intake path would read it as an
    // unsupported update and silently do nothing.
    const update = {
      update_id: 9,
      callback_query: { id: "cb-1", from: { id: ALLOWED_ID }, data: "c:aaaaaaaaaaaaaaaa:tok123456789" },
    };
    const response = await worker.fetch(webhookRequest(update), testEnv(), ctx());

    expect(response.status).toBe(200);
    expect(storage.objects.size).toBe(0);
  });

  it("asks Telegram to redeliver when storage fails", async () => {
    // The one place a retry is worth having: the decision was fine, the write
    // was not. Everything above this point would decide the same way again.
    storage.failNextPut();
    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), testEnv(), ctx());
    expect(response.status).toBe(503);
    expect(authored()).toEqual([]);
  });

  it("ignores an update carrying no sender", async () => {
    const channelPost = {
      update_id: 2,
      message: { message_id: 11, date: 1_700_000_000, chat: { id: 99, type: "channel" }, text: "hi" },
    };
    const response = await worker.fetch(webhookRequest(channelPost), testEnv(), ctx());
    expect(response.status).toBe(200);
  });
});

/**
 * Log Explorer is not enabled on this account, so the bucket is the only place
 * a past failure can be read from. What matters is that it holds the failures
 * and nothing else: an object per stranger's probe would be a way to fill it.
 */
describe("error log", () => {
  it("does not persist a missing callback-secret diagnostic for arbitrary callers", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/callbacks/media-processed", { method: "POST" }),
      testEnv({ CALLBACK_HMAC_SECRET: undefined }),
      ctx(),
    );

    expect(response.status).toBe(401);
    expect(errorLogs()).toEqual([]);
  });

  it("records a failure with the reason attached", async () => {
    storage.failNextPut();
    await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), testEnv(), ctx());

    expect(errorLogs()).toEqual([expect.stringMatching(/^logs\/\d{4}-\d{2}-\d{2}\/\d{9}-[0-9a-z]{8}\.json$/)]);

    const written = JSON.parse(storage.objects.get(errorLogs()[0]) as string);
    expect(written).toMatchObject({ method: "POST", path: "/telegram/webhook", status: 503 });
    expect(written.entries).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("Could not store the draft") }),
    );
  });

  it("writes nothing for a request that only warned", async () => {
    // An unparseable body warns and is otherwise ignored. Anyone who finds this
    // URL can send one; storing each would hand them the bucket.
    const response = await worker.fetch(webhookRequest("{not json"), testEnv(), ctx());

    expect(response.status).toBe(200);
    expect(errorLogs()).toEqual([]);
  });

  it("writes nothing for a request that succeeded", async () => {
    await worker.fetch(new Request("https://worker.example/", { method: "POST" }), testEnv(), ctx());
    expect(errorLogs()).toEqual([]);
  });

  it("turns an uncaught throw into a 500 that says why", async () => {
    // A thrown error would otherwise reach the platform, which answers with its
    // own page and takes the reason down with the isolate.
    const exploding = testEnv();
    Object.defineProperty(exploding, "TELEGRAM_WEBHOOK_SECRET", {
      get() {
        throw new Error("binding exploded");
      },
    });

    const response = await worker.fetch(webhookRequest(messageFrom(ALLOWED_ID)), exploding, ctx());

    expect(response.status).toBe(500);
    const written = JSON.parse(storage.objects.get(errorLogs()[0]) as string);
    expect(written.entries[0].message).toContain("binding exploded");
  });
});

describe("routing", () => {
  it("does not answer GET on the webhook path", async () => {
    const response = await worker.fetch(new Request(WEBHOOK_URL), testEnv(), ctx());
    expect(response.status).toBe(404);
  });

  it("says nothing useful about unknown paths", async () => {
    const response = await worker.fetch(new Request("https://worker.example/", { method: "POST" }), testEnv(), ctx());
    expect(response.status).toBe(404);
  });
});
