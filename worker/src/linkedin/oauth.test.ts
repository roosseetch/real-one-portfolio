import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizeUrl,
  exchangeCode,
  fetchAuthorUrn,
  isConfigured,
  redirectUri,
  refreshAccessToken,
} from "./oauth";

const ENV = {
  LINKEDIN_CLIENT_ID: "client-id",
  LINKEDIN_CLIENT_SECRET: "client-secret",
  WORKER_BASE_URL: "https://worker.example",
};

/** Every fetch, as {url, body} — the bodies are form-encoded here, not JSON. */
let calls: Array<{ url: string; body: string; headers: Record<string, string> }>;

function answer(status: number, payload: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body === undefined ? "" : String(init.body),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isConfigured", () => {
  it("needs all three, because a login link missing any of them cannot succeed", () => {
    expect(isConfigured(ENV)).toBe(true);
    expect(isConfigured({ ...ENV, LINKEDIN_CLIENT_ID: undefined })).toBe(false);
    expect(isConfigured({ ...ENV, LINKEDIN_CLIENT_SECRET: undefined })).toBe(false);
    expect(isConfigured({ ...ENV, WORKER_BASE_URL: undefined })).toBe(false);
    expect(isConfigured({ ...ENV, LINKEDIN_CLIENT_ID: "" })).toBe(false);
  });
});

describe("redirectUri", () => {
  it("is the Worker's own callback route", () => {
    expect(redirectUri(ENV)).toBe("https://worker.example/linkedin/callback");
  });

  it("does not double the slash on a base that has one", () => {
    expect(redirectUri({ ...ENV, WORKER_BASE_URL: "https://worker.example/" })).toBe(
      "https://worker.example/linkedin/callback",
    );
  });
});

describe("authorizeUrl", () => {
  it("asks for exactly the scopes the flow needs and nothing else", () => {
    const url = new URL(authorizeUrl(ENV, "state-value"));

    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("redirect_uri")).toBe("https://worker.example/linkedin/callback");
    // w_member_social posts; openid and profile are only there because the
    // member's own URN has to be read before anything is authored as them.
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
  });

  it("never carries the client secret", () => {
    expect(authorizeUrl(ENV, "state-value")).not.toContain("client-secret");
  });
});

describe("exchangeCode", () => {
  it("posts the grant form-encoded and reads the token back", async () => {
    answer(200, { access_token: "tok", expires_in: 5184000 });

    const result = await exchangeCode(ENV, "the-code");

    expect(result).toEqual({
      status: "granted",
      token: { accessToken: "tok", expiresIn: 5184000, refreshToken: null, refreshExpiresIn: null },
    });

    const body = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    // LinkedIn checks this against the one used on the authorize call.
    expect(body.get("redirect_uri")).toBe("https://worker.example/linkedin/callback");
    expect(body.get("client_secret")).toBe("client-secret");
  });

  it("keeps a refresh token when the app is approved for one", async () => {
    answer(200, {
      access_token: "tok",
      expires_in: 5184000,
      refresh_token: "refresh",
      refresh_token_expires_in: 31536000,
    });

    const result = await exchangeCode(ENV, "the-code");

    expect(result.status).toBe("granted");
    expect(result.status === "granted" && result.token.refreshToken).toBe("refresh");
    expect(result.status === "granted" && result.token.refreshExpiresIn).toBe(31536000);
  });

  it("treats a missing expiry as already expired rather than as forever", async () => {
    answer(200, { access_token: "tok" });

    const result = await exchangeCode(ENV, "the-code");
    expect(result.status === "granted" && result.token.expiresIn).toBe(0);
  });

  it("fails rather than throwing when LinkedIn rejects it", async () => {
    answer(400, { error: "invalid_grant" });
    expect(await exchangeCode(ENV, "the-code")).toEqual({ status: "failed" });
  });

  it("fails on a body that is not JSON", async () => {
    answer(200, "<html>maintenance</html>");
    expect(await exchangeCode(ENV, "the-code")).toEqual({ status: "failed" });
  });

  it("fails on a 200 that carries no token", async () => {
    answer(200, { expires_in: 5184000 });
    expect(await exchangeCode(ENV, "the-code")).toEqual({ status: "failed" });
  });

  it("fails rather than throwing when LinkedIn cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await exchangeCode(ENV, "the-code")).toEqual({ status: "failed" });
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh grant", async () => {
    answer(200, { access_token: "fresh", expires_in: 5184000 });

    const result = await refreshAccessToken(ENV, "refresh");

    expect(result.status).toBe("granted");
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh");
    // Not part of a refresh, and LinkedIn rejects it if sent.
    expect(body.get("redirect_uri")).toBeNull();
  });
});

describe("fetchAuthorUrn", () => {
  it("builds the member URN from the OpenID subject", async () => {
    answer(200, { sub: "abc123" });

    expect(await fetchAuthorUrn("tok")).toBe("urn:li:person:abc123");
    expect(calls[0].url).toBe("https://api.linkedin.com/v2/userinfo");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("refuses a subject that is not URN-shaped", async () => {
    // It is about to name who authored a public post.
    answer(200, { sub: "abc/../../evil" });
    expect(await fetchAuthorUrn("tok")).toBeNull();
  });

  it("returns null rather than throwing on a rejection", async () => {
    answer(401, { message: "expired" });
    expect(await fetchAuthorUrn("tok")).toBeNull();
  });
});
