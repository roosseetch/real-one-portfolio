import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { handleLinkedInConnect } from "./connect";
import { createState } from "./state";
import { loadToken } from "./tokens";

let storage: FakeBucket;
let content: FakeBucket;
let calls: Array<{ host: string; path: string; body: Record<string, unknown> }>;
/** Whether LinkedIn grants a token for the code. */
let exchangeOk: boolean;
/** Whether /v2/userinfo answers with a member id. */
let userinfoOk: boolean;

const CHAT = 99;
const RECORD = "aaaaaaaaaaaaaaa1";

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

function sent(): string[] {
  return calls.filter((c) => c.path.endsWith("/sendMessage")).map((c) => String(c.body.text));
}

function published(record: PublicRecord): void {
  const manifest: Manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    recordsPerFile: 10,
    totalRecords: 1,
    records: [{ id: "chunk0", sha256: "x", count: 1 }],
    latest: "chunk0",
  };
  content.objects.set(chunkKey("chunk0"), JSON.stringify([record]));
  content.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
}

function callback(query: string): Request {
  return new Request(`https://worker.example/linkedin/callback?${query}`);
}

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  calls = [];
  exchangeOk = true;
  userinfoOk = true;

  published({
    id: RECORD,
    title: "Morning run by the river",
    summary: "An easy 8 km before work.",
    body: null,
    eventDate: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    tags: [],
    media: [],
  });

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    const isForm = String(
      init?.headers && (init.headers as Record<string, string>)["content-type"],
    ).includes("x-www-form-urlencoded");

    calls.push({
      host: target.host,
      path: target.pathname,
      body: init?.body
        ? isForm
          ? Object.fromEntries(new URLSearchParams(String(init.body)))
          : JSON.parse(String(init.body))
        : {},
    });

    if (target.pathname === "/oauth/v2/accessToken") {
      return exchangeOk
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 5184000 }), { status: 200 })
        : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }

    if (target.pathname === "/v2/userinfo") {
      return userinfoOk
        ? new Response(JSON.stringify({ sub: "abc123" }), { status: 200 })
        : new Response(null, { status: 401 });
    }

    if (target.pathname === "/rest/posts") {
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7123" } });
    }

    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a finished login", () => {
  it("stores the token and posts the activity that was waiting", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);

    const response = await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    expect(response.status).toBe(200);
    expect(await loadToken(storage.bucket)).toMatchObject({
      accessToken: "tok",
      authorUrn: "urn:li:person:abc123",
    });
    expect(calls.some((c) => c.path === "/rest/posts")).toBe(true);
    expect(sent()).toEqual([
      "LinkedIn reconnected.",
      'Posted "Morning run by the river" to LinkedIn. https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7123/',
    ]);
  });

  it("stops at the token when nothing was waiting on the login", async () => {
    const state = await createState(storage.bucket, CHAT, null);

    await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    expect(await loadToken(storage.bucket)).not.toBeNull();
    expect(calls.some((c) => c.path === "/rest/posts")).toBe(false);
    expect(sent()).toEqual(["LinkedIn reconnected."]);
  });

  it("answers a page rather than redirecting a browser carrying an authorization code", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);

    const response = await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("a callback that proves nothing", () => {
  /**
   * This route is open to the internet by necessity — LinkedIn redirects a
   * browser to it — so the state is the whole guard. Every refusal answers the
   * same page: telling them apart tells a stranger which of their guesses landed.
   */
  it("does nothing at all without a state", async () => {
    const response = await handleLinkedInConnect(callback("code=the-code"), env());

    expect(response.status).toBe(200);
    expect(await loadToken(storage.bucket)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does nothing for a state that was never minted", async () => {
    await handleLinkedInConnect(
      callback("code=the-code&state=k3m9qq2vabcd1234abcd1234"),
      env(),
    );

    expect(await loadToken(storage.bucket)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does nothing for one that has already been spent", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);
    await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    const before = calls.length;
    await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    // A prefetched or reloaded redirect must not post the activity twice.
    expect(calls.length).toBe(before);
  });

  it("does nothing for one that has expired", async () => {
    const state = await createState(
      storage.bucket,
      CHAT,
      RECORD,
      new Date(Date.now() - 60 * 60 * 1000),
    );

    await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    expect(await loadToken(storage.bucket)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("a login that went wrong", () => {
  it("reports LinkedIn's own refusal in the chat, not on the page", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);

    const response = await handleLinkedInConnect(
      callback(`error=user_cancelled_login&state=${state}`),
      env(),
    );

    expect(response.status).toBe(200);
    expect(sent()).toEqual(["That LinkedIn login did not finish, so nothing was posted."]);
    expect(await loadToken(storage.bucket)).toBeNull();
  });

  it("reports a redirect carrying neither a code nor an error", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);

    await handleLinkedInConnect(callback(`state=${state}`), env());

    expect(sent()).toEqual(["That LinkedIn login did not finish, so nothing was posted."]);
  });

  it("reports a code LinkedIn would not exchange", async () => {
    exchangeOk = false;
    const state = await createState(storage.bucket, CHAT, RECORD);

    await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    expect(sent()).toEqual(["LinkedIn would not issue a token for that login. Try the button again."]);
    expect(await loadToken(storage.bucket)).toBeNull();
  });

  it("stores nothing when LinkedIn will not say whose account it is", async () => {
    // Every post has to name its author, so a token that cannot answer that is
    // worse than no token: it would fail at the moment of posting instead.
    userinfoOk = false;
    const state = await createState(storage.bucket, CHAT, RECORD);

    await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    expect(sent()).toEqual(["LinkedIn would not say who that account is. Try the button again."]);
    expect(await loadToken(storage.bucket)).toBeNull();
  });

  it("says so when the token cannot be stored, rather than posting on a credential it will lose", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);
    storage.failPutsFor((key) => key === "linkedin/token.json");

    await handleLinkedInConnect(callback(`code=the-code&state=${state}`), env());

    expect(sent()).toEqual(["I could not save that LinkedIn login. Try the button again."]);
    expect(calls.some((c) => c.path === "/rest/posts")).toBe(false);
  });
});
