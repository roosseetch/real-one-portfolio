import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramCallbackQuery } from "../telegram/types";
import { askForLogin, handleRepostCallback, isRepostCallback, promptForActivity, repostRecord } from "./repost";
import { saveToken, loadToken, type LinkedInToken } from "./tokens";

let storage: FakeBucket;
let content: FakeBucket;
/** Every outbound call, as {host, method, body, headers}. */
let calls: Array<{ host: string; method: string; body: Record<string, unknown>; headers: Record<string, string> }>;
/** What LinkedIn's /rest/posts answers, so a test can make it reject. */
let postStatus: number;
/** Whether the token endpoint grants a refresh. */
let refreshGranted: boolean;

const CHAT = 99;

function env() {
  return {
    PRIVATE_BUCKET: storage.bucket,
    CONTENT_BUCKET: content.bucket,
    TELEGRAM_BOT_TOKEN: "test-token",
    SITE_BASE_URL: "https://site.example",
    WORKER_BASE_URL: "https://worker.example",
    LINKEDIN_CLIENT_ID: "client-id",
    LINKEDIN_CLIENT_SECRET: "client-secret",
  };
}

/** Messages the bot sent, in order. */
function sent(): string[] {
  return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
}

/** The reply markup on the last message that carried one. */
function lastKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
  const withMarkup = calls.filter((c) => c.body.reply_markup !== undefined);
  const markup = withMarkup[withMarkup.length - 1]?.body.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  return markup?.inline_keyboard ?? [];
}

function record(id: string, title: string, publishedAt: string | null): PublicRecord {
  return {
    id,
    title,
    summary: "A summary.",
    body: null,
    eventDate: null,
    publishedAt: publishedAt as string,
    tags: [],
    media: [],
  };
}

/** Writes chunks in publication order, oldest first, and a manifest pointing at them. */
async function publish(chunks: PublicRecord[][]): Promise<void> {
  const manifest: Manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    recordsPerFile: 10,
    totalRecords: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    records: chunks.map((chunk, index) => ({ id: `chunk${index}`, sha256: "x", count: chunk.length })),
    latest: `chunk${chunks.length - 1}`,
  };

  for (const [index, chunk] of chunks.entries()) {
    content.objects.set(chunkKey(`chunk${index}`), JSON.stringify(chunk));
  }
  content.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
}

function token(overrides: Partial<LinkedInToken> = {}): LinkedInToken {
  return {
    accessToken: "tok",
    // Far enough out that isUsable says yes without any clock injection.
    expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
    refreshToken: null,
    refreshExpiresAt: null,
    authorUrn: "urn:li:person:abc123",
    connectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function press(data: string): TelegramCallbackQuery {
  return {
    id: "cb-1",
    from: { id: 42 },
    data,
    message: { message_id: 7, date: 0, chat: { id: CHAT, type: "private" } },
  };
}

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  calls = [];
  postStatus = 201;
  refreshGranted = true;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    const method = target.pathname.split("/").pop() ?? "";
    const isForm = String(init?.headers && (init.headers as Record<string, string>)["content-type"]).includes(
      "x-www-form-urlencoded",
    );

    calls.push({
      host: target.host,
      method,
      body: init?.body
        ? isForm
          ? Object.fromEntries(new URLSearchParams(String(init.body)))
          : JSON.parse(String(init.body))
        : {},
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    if (target.host === "api.linkedin.com" && target.pathname === "/rest/posts") {
      return new Response(null, {
        status: postStatus,
        headers: postStatus === 201 ? { "x-restli-id": "urn:li:share:7123" } : {},
      });
    }

    if (target.pathname === "/oauth/v2/accessToken") {
      return refreshGranted
        ? new Response(JSON.stringify({ access_token: "fresh", expires_in: 5184000 }), { status: 200 })
        : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }

    if (target.pathname === "/v2/userinfo") {
      return new Response(JSON.stringify({ sub: "abc123" }), { status: 200 });
    }

    // Telegram.
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isRepostCallback", () => {
  it("claims its own namespace and nothing else", () => {
    expect(isRepostCallback("l:p:abc")).toBe(true);
    expect(isRepostCallback("l:x")).toBe(true);
    // The draft preview's codes, which must keep reaching the draft handler.
    expect(isRepostCallback("p:draft123:token123")).toBe(false);
    expect(isRepostCallback(undefined)).toBe(false);
  });
});

describe("promptForActivity", () => {
  it("offers the newest five, with the top one labelled as the default", async () => {
    await publish([
      [
        record("aaaaaaaaaaaaaaa1", "One", "2026-08-01T00:00:00.000Z"),
        record("aaaaaaaaaaaaaaa2", "Two", "2026-08-02T00:00:00.000Z"),
        record("aaaaaaaaaaaaaaa3", "Three", "2026-08-03T00:00:00.000Z"),
        record("aaaaaaaaaaaaaaa4", "Four", "2026-08-04T00:00:00.000Z"),
        record("aaaaaaaaaaaaaaa5", "Five", "2026-08-05T00:00:00.000Z"),
        record("aaaaaaaaaaaaaaa6", "Six", "2026-08-06T00:00:00.000Z"),
      ],
    ]);

    await promptForActivity(env(), CHAT);

    const keyboard = lastKeyboard();
    expect(keyboard.map((row) => row[0].text)).toEqual([
      "Latest — Six",
      "Five",
      "Four",
      "Three",
      "Two",
      "Cancel",
    ]);
    expect(keyboard[0][0].callback_data).toBe("l:p:aaaaaaaaaaaaaaa6");
  });

  /**
   * The newest chunk can have just rolled and hold a single record, and a
   * chooser with one entry is not a choice.
   */
  it("reaches into the previous chunk when the newest has just rolled", async () => {
    await publish([
      [
        record("bbbbbbbbbbbbbbb1", "Old one", "2026-07-01T00:00:00.000Z"),
        record("bbbbbbbbbbbbbbb2", "Old two", "2026-07-02T00:00:00.000Z"),
        record("bbbbbbbbbbbbbbb3", "Old three", "2026-07-03T00:00:00.000Z"),
        record("bbbbbbbbbbbbbbb4", "Old four", "2026-07-04T00:00:00.000Z"),
      ],
      [record("ccccccccccccccc1", "Newest", "2026-08-01T00:00:00.000Z")],
    ]);

    await promptForActivity(env(), CHAT);

    expect(lastKeyboard().map((row) => row[0].text)).toEqual([
      "Latest — Newest",
      "Old four",
      "Old three",
      "Old two",
      "Old one",
      "Cancel",
    ]);
  });

  /**
   * The same rule as the site's feed: eventDate is null whenever the note named
   * no date, so ordering on it would drop every undated record to the bottom
   * however recent it is.
   */
  it("puts a record published before publishedAt existed behind every record that has one", async () => {
    await publish([
      [record("ddddddddddddddd1", "Ancient", null), record("ddddddddddddddd2", "Recent", "2026-08-01T00:00:00.000Z")],
    ]);

    await promptForActivity(env(), CHAT);

    expect(lastKeyboard().map((row) => row[0].text)).toEqual(["Latest — Recent", "Ancient", "Cancel"]);
  });

  it("shortens a long title rather than letting Telegram cut it anywhere", async () => {
    await publish([[record("eeeeeeeeeeeeeee1", "A".repeat(80), "2026-08-01T00:00:00.000Z")]]);

    await promptForActivity(env(), CHAT);

    const [label] = lastKeyboard()[0].map((button) => button.text);
    expect(label.length).toBeLessThanOrEqual("Latest — ".length + 40);
    expect(label.endsWith("…")).toBe(true);
  });

  it("says so when nothing has been published", async () => {
    await publish([[]]);
    await promptForActivity(env(), CHAT);
    expect(sent()).toEqual(["Nothing has been published yet, so there is nothing to repost."]);
  });

  it("says so when LinkedIn is not set up, rather than offering a button that cannot work", async () => {
    await publish([[record("fffffffffffffff1", "One", "2026-08-01T00:00:00.000Z")]]);

    await promptForActivity({ ...env(), LINKEDIN_CLIENT_ID: undefined }, CHAT);

    expect(sent()).toEqual(["LinkedIn is not set up for this deployment, so there is nothing to repost to."]);
  });
});

describe("pressing a button", () => {
  beforeEach(async () => {
    await publish([[record("aaaaaaaaaaaaaaa1", "Morning run by the river", "2026-08-01T00:00:00.000Z")]]);
  });

  it("shows the exact post and asks before anything reaches LinkedIn", async () => {
    await saveToken(storage.bucket, token());

    await handleRepostCallback(press("l:p:aaaaaaaaaaaaaaa1"), env());

    expect(sent()[0]).toContain("Post this to LinkedIn?");
    expect(sent()[0]).toContain("Morning run by the river");
    expect(sent()[0]).toContain("https://site.example/activities/?v=morning-run-by-the-river");
    expect(lastKeyboard()[0][0]).toEqual({
      text: "Post to LinkedIn",
      callback_data: "l:g:aaaaaaaaaaaaaaa1",
    });
    // Nothing was posted by choosing.
    expect(calls.some((c) => c.host === "api.linkedin.com")).toBe(false);
  });

  it("shows the words as LinkedIn will render them, not the escapes", async () => {
    await publish([[{ ...record("aaaaaaaaaaaaaaa1", "Run (easy)", "2026-08-01T00:00:00.000Z") }]]);
    await saveToken(storage.bucket, token());

    await handleRepostCallback(press("l:p:aaaaaaaaaaaaaaa1"), env());

    expect(sent()[0]).toContain("Run (easy)");
    expect(sent()[0]).not.toContain("\\(");
  });

  it("posts on the second press and hands back the LinkedIn link", async () => {
    await saveToken(storage.bucket, token());

    await handleRepostCallback(press("l:g:aaaaaaaaaaaaaaa1"), env());

    const post = calls.find((c) => c.host === "api.linkedin.com");
    expect(post?.body.author).toBe("urn:li:person:abc123");
    expect(sent()).toEqual([
      'Posted "Morning run by the river" to LinkedIn. https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7123/',
    ]);
  });

  it("posts nothing on Cancel", async () => {
    await saveToken(storage.bucket, token());

    await handleRepostCallback(press("l:x"), env());

    expect(calls.some((c) => c.host === "api.linkedin.com")).toBe(false);
    expect(sent()).toEqual(["Nothing was posted to LinkedIn."]);
  });

  it("always stops the button spinning, including on a press it refuses", async () => {
    await handleRepostCallback(press("l:zzz"), env());
    expect(calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });

  it("says so when the activity has gone", async () => {
    await saveToken(storage.bucket, token());

    await handleRepostCallback(press("l:g:99999999999999z9"), env());

    expect(sent()).toEqual(["I could not find that activity any more."]);
  });

  it("refuses a record id that could name a different object", async () => {
    await saveToken(storage.bucket, token());
    await handleRepostCallback(press("l:g:../../linkedin/token"), env());
    expect(sent()).toEqual(["I could not find that activity any more."]);
  });
});

describe("when the token has run out", () => {
  beforeEach(async () => {
    await publish([[record("aaaaaaaaaaaaaaa1", "Morning run by the river", "2026-08-01T00:00:00.000Z")]]);
  });

  /**
   * The common case: most apps get no refresh token, so a sixty-day expiry is a
   * normal Tuesday rather than an incident.
   */
  it("sends a login link and remembers the activity", async () => {
    await saveToken(storage.bucket, token({ expiresAt: "2020-01-01T00:00:00.000Z" }));

    const outcome = await repostRecord(env(), CHAT, "aaaaaaaaaaaaaaa1");

    expect(outcome).toBe("needs-login");
    expect(calls.some((c) => c.host === "api.linkedin.com")).toBe(false);

    const message = sent()[0];
    expect(message).toContain("The LinkedIn access token has expired.");
    expect(message).toContain("I will post it for you");
    expect(message).toContain("https://www.linkedin.com/oauth/v2/authorization");

    // The state carries the activity across the login, which is what lets one
    // tap finish what the press started.
    const stateKey = [...storage.objects.keys()].find((key) => key.startsWith("drafts/linkedin-state/"));
    expect(JSON.parse(storage.objects.get(stateKey!)!)).toMatchObject({
      chatId: CHAT,
      recordId: "aaaaaaaaaaaaaaa1",
    });
  });

  it("refreshes silently when it has a refresh token, and never mentions it", async () => {
    await saveToken(
      storage.bucket,
      token({ expiresAt: "2020-01-01T00:00:00.000Z", refreshToken: "refresh" }),
    );

    const outcome = await repostRecord(env(), CHAT, "aaaaaaaaaaaaaaa1");

    expect(outcome).toBe("posted");
    expect(sent()[0]).toContain("Posted");
    expect(sent()[0]).not.toContain("log in");
    // And the renewed token is kept, so the next post does not refresh again.
    expect((await loadToken(storage.bucket))?.accessToken).toBe("fresh");
  });

  it("asks for a login when the refresh is itself refused", async () => {
    refreshGranted = false;
    await saveToken(
      storage.bucket,
      token({ expiresAt: "2020-01-01T00:00:00.000Z", refreshToken: "refresh" }),
    );

    expect(await repostRecord(env(), CHAT, "aaaaaaaaaaaaaaa1")).toBe("needs-login");
  });

  /**
   * A token can also be revoked from the member's own settings page, which our
   * arithmetic about the expiry knows nothing about.
   */
  it("retries once behind a 401 that arrives on a token we thought was good", async () => {
    postStatus = 401;
    await saveToken(storage.bucket, token({ refreshToken: "refresh" }));

    const outcome = await repostRecord(env(), CHAT, "aaaaaaaaaaaaaaa1");

    expect(outcome).toBe("needs-login");
    // Exactly twice: once with the stored token, once with the refreshed one.
    expect(calls.filter((c) => c.host === "api.linkedin.com").length).toBe(2);
    expect(sent()[0]).toContain("LinkedIn turned that down");
  });

  it("does not retry a 401 it has no refresh token for", async () => {
    postStatus = 401;
    await saveToken(storage.bucket, token());

    expect(await repostRecord(env(), CHAT, "aaaaaaaaaaaaaaa1")).toBe("needs-login");
    expect(calls.filter((c) => c.host === "api.linkedin.com").length).toBe(1);
  });

  it("asks for a login when nothing has ever been connected", async () => {
    expect(await repostRecord(env(), CHAT, "aaaaaaaaaaaaaaa1")).toBe("needs-login");
    expect(sent()[0]).toContain("https://www.linkedin.com/oauth/v2/authorization");
  });

  it("leaves the draft alone and says so on an ordinary failure", async () => {
    postStatus = 422;
    await saveToken(storage.bucket, token());

    expect(await repostRecord(env(), CHAT, "aaaaaaaaaaaaaaa1")).toBe("failed");
    expect(sent()).toEqual([
      "LinkedIn would not take that post. The activity is still on the site — try again in a moment.",
    ]);
  });
});

describe("a login with nothing waiting on it", () => {
  it("says the button will work rather than promising a post that was never chosen", async () => {
    await askForLogin(env(), CHAT, null, "expired");

    expect(sent()[0]).toContain("Log in again and the button will work.");
    expect(sent()[0]).not.toContain("I will post it for you");
  });

  it("says so rather than sending a dead link when the state cannot be stored", async () => {
    storage.failNextPut("R2 unavailable");

    await askForLogin(env(), CHAT, null, "expired");

    expect(sent()).toEqual(["I could not start a LinkedIn login just now. Try again in a moment."]);
  });
});
