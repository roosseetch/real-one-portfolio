import { describe, expect, it } from "vitest";

import { authorizeWebhook, parseAllowedUserIds, senderId, type TelegramEnv } from "./webhook";
import type { TelegramUpdate } from "./types";

const SECRET = "test-webhook-secret";
const ALLOWED_ID = 4242;

function env(overrides: Partial<TelegramEnv> = {}): TelegramEnv {
  return {
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_ALLOWED_USER_IDS: String(ALLOWED_ID),
    ...overrides,
  };
}

/** `secret: null` omits the header entirely, which is not the same as sending an empty one. */
function request(body: unknown, secret: string | null = SECRET, header = "X-Telegram-Bot-Api-Secret-Token") {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set(header, secret);
  return new Request("https://worker.example/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function message(fromId: number | undefined): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 99, type: "private" },
      ...(fromId === undefined ? {} : { from: { id: fromId } }),
      text: "hello",
    },
  };
}

describe("parseAllowedUserIds", () => {
  it("reads a single id", () => {
    expect(parseAllowedUserIds("42")).toEqual(new Set([42]));
  });

  it("trims whitespace around entries", () => {
    expect(parseAllowedUserIds(" 42 , 43 ")).toEqual(new Set([42, 43]));
  });

  it("skips empty entries from stray commas", () => {
    expect(parseAllowedUserIds("42,,43,")).toEqual(new Set([42, 43]));
  });

  it("denies everyone when unset or empty", () => {
    expect(parseAllowedUserIds(undefined).size).toBe(0);
    expect(parseAllowedUserIds("").size).toBe(0);
    expect(parseAllowedUserIds("   ").size).toBe(0);
  });

  it("drops junk without discarding the valid entries beside it", () => {
    expect(parseAllowedUserIds("abc,42")).toEqual(new Set([42]));
  });

  it("rejects anything that is not a plain positive integer", () => {
    // Each of these would survive a bare Number() and then silently match
    // nothing, or worse, round to an id that is not the one configured.
    expect(parseAllowedUserIds("-1,1.5,1e3,0x2a,9007199254740993").size).toBe(0);
  });

  it("collapses duplicates", () => {
    expect(parseAllowedUserIds("42,42").size).toBe(1);
  });
});

describe("senderId", () => {
  it("reads the sender of a message", () => {
    expect(senderId(message(7))).toBe(7);
  });

  it("reads the sender of an edited message", () => {
    const update: TelegramUpdate = { update_id: 2, edited_message: message(8).message };
    expect(senderId(update)).toBe(8);
  });

  it("reads the sender of a callback query", () => {
    const update: TelegramUpdate = {
      update_id: 3,
      callback_query: { id: "cb", from: { id: 9 }, data: "publish" },
    };
    expect(senderId(update)).toBe(9);
  });

  it("returns null for a message without a sender", () => {
    // The shape of a channel post: a message, no `from`.
    expect(senderId(message(undefined))).toBeNull();
  });

  it("returns null when the id is not a number", () => {
    const update = { update_id: 4, message: { from: { id: "7" } } } as unknown as TelegramUpdate;
    expect(senderId(update)).toBeNull();
  });

  it("returns null for an update carrying nothing we handle", () => {
    expect(senderId({ update_id: 5 })).toBeNull();
  });
});

describe("authorizeWebhook", () => {
  it("rejects a request with no secret header", async () => {
    expect(await authorizeWebhook(request(message(ALLOWED_ID), null), env())).toEqual({
      status: "unauthenticated",
    });
  });

  it("rejects the wrong secret", async () => {
    expect(await authorizeWebhook(request(message(ALLOWED_ID), "not-the-secret"), env())).toEqual({
      status: "unauthenticated",
    });
  });

  it("rejects a secret that is only a prefix of the real one", async () => {
    expect(await authorizeWebhook(request(message(ALLOWED_ID), SECRET.slice(0, -1)), env())).toEqual({
      status: "unauthenticated",
    });
  });

  it("rejects everything when the secret is not configured", async () => {
    // The case a bare `presented === configured` would wave through: both sides
    // empty and therefore equal.
    const unconfigured = env({ TELEGRAM_WEBHOOK_SECRET: undefined });
    expect(await authorizeWebhook(request(message(ALLOWED_ID), ""), unconfigured)).toEqual({
      status: "unauthenticated",
    });
    expect(await authorizeWebhook(request(message(ALLOWED_ID)), unconfigured)).toEqual({
      status: "unauthenticated",
    });
  });

  it("matches the header however Telegram cases it", async () => {
    const result = await authorizeWebhook(
      request(message(ALLOWED_ID), SECRET, "x-telegram-bot-api-secret-token"),
      env(),
    );
    expect(result.status).toBe("authorized");
  });

  it("ignores a body that is not JSON", async () => {
    expect(await authorizeWebhook(request("{not json", SECRET), env())).toEqual({
      status: "ignored",
      reason: "unparseable",
    });
  });

  it("ignores a payload that is not an update", async () => {
    expect(await authorizeWebhook(request({ foo: 1 }, SECRET), env())).toEqual({
      status: "ignored",
      reason: "unparseable",
    });
    expect(await authorizeWebhook(request([1, 2, 3], SECRET), env())).toEqual({
      status: "ignored",
      reason: "unparseable",
    });
  });

  it("ignores an update with no sender", async () => {
    expect(await authorizeWebhook(request(message(undefined), SECRET), env())).toEqual({
      status: "ignored",
      reason: "no-sender",
    });
  });

  it("ignores a sender who is not on the allowlist", async () => {
    expect(await authorizeWebhook(request(message(ALLOWED_ID + 1), SECRET), env())).toEqual({
      status: "ignored",
      reason: "sender-not-allowed",
    });
  });

  it("ignores everyone when the allowlist is empty", async () => {
    const result = await authorizeWebhook(
      request(message(ALLOWED_ID), SECRET),
      env({ TELEGRAM_ALLOWED_USER_IDS: "" }),
    );
    expect(result).toEqual({ status: "ignored", reason: "sender-not-allowed" });
  });

  it("authorizes an allowlisted sender and hands back the update", async () => {
    const result = await authorizeWebhook(request(message(ALLOWED_ID), SECRET), env());
    expect(result).toMatchObject({ status: "authorized", senderId: ALLOWED_ID });
    if (result.status !== "authorized") throw new Error("expected authorization");
    expect(result.update.update_id).toBe(1);
    expect(result.update.message?.text).toBe("hello");
  });

  it("authorizes a button press as well as a message", async () => {
    // The seam Task 17 depends on: approval buttons arrive as callback queries,
    // not messages, and must pass the same gate.
    const update: TelegramUpdate = {
      update_id: 6,
      callback_query: { id: "cb", from: { id: ALLOWED_ID }, data: "publish" },
    };
    expect(await authorizeWebhook(request(update, SECRET), env())).toMatchObject({
      status: "authorized",
      senderId: ALLOWED_ID,
    });
  });

  it("authorizes one of several allowlisted senders", async () => {
    const result = await authorizeWebhook(
      request(message(43), SECRET),
      env({ TELEGRAM_ALLOWED_USER_IDS: "42, 43 ,44" }),
    );
    expect(result).toMatchObject({ status: "authorized", senderId: 43 });
  });
});
