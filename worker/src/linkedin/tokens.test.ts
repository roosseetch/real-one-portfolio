import { beforeEach, describe, expect, it } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import {
  canRefresh,
  clearToken,
  isUsable,
  loadToken,
  saveToken,
  tokenFromGrant,
  type LinkedInToken,
} from "./tokens";

let storage: FakeBucket;

beforeEach(() => {
  storage = createFakeBucket();
});

const NOW = new Date("2026-08-12T10:00:00.000Z");

function token(overrides: Partial<LinkedInToken> = {}): LinkedInToken {
  return {
    accessToken: "tok",
    expiresAt: "2026-10-11T10:00:00.000Z",
    refreshToken: null,
    refreshExpiresAt: null,
    authorUrn: "urn:li:person:abc123",
    connectedAt: "2026-08-12T10:00:00.000Z",
    ...overrides,
  };
}

describe("storage", () => {
  it("round-trips a token", async () => {
    await saveToken(storage.bucket, token());
    expect(await loadToken(storage.bucket)).toEqual(token());
  });

  /**
   * The `drafts/` prefix has a seven-day lifecycle rule. A token stored under it
   * would be deleted on its eighth day and present as "LinkedIn keeps logging me
   * out", with nothing in any log to say why.
   */
  it("stores it outside the prefix the lifecycle rule sweeps", async () => {
    await saveToken(storage.bucket, token());
    expect([...storage.objects.keys()]).toEqual(["linkedin/token.json"]);
  });

  it("reads as absent when there is nothing stored", async () => {
    expect(await loadToken(storage.bucket)).toBeNull();
  });

  it("reads as absent when the stored object is not a token", async () => {
    storage.objects.set("linkedin/token.json", "not json");
    expect(await loadToken(storage.bucket)).toBeNull();
  });

  it("reads as absent when the stored token names no author", async () => {
    // Every post has to name who authored it, so a token that cannot answer
    // that is not usable — and "log in again" is the only useful reply.
    storage.objects.set("linkedin/token.json", JSON.stringify({ accessToken: "t", expiresAt: "x" }));
    expect(await loadToken(storage.bucket)).toBeNull();
  });

  it("clears", async () => {
    await saveToken(storage.bucket, token());
    await clearToken(storage.bucket);
    expect(await loadToken(storage.bucket)).toBeNull();
  });
});

describe("isUsable", () => {
  it("accepts a token with life left", () => {
    expect(isUsable(token(), NOW)).toBe(true);
  });

  it("refuses one that has expired", () => {
    expect(isUsable(token({ expiresAt: "2026-08-12T09:00:00.000Z" }), NOW)).toBe(false);
  });

  // Refreshed a little early, so a post never races the clock between the check
  // and the call.
  it("refuses one that is about to expire", () => {
    expect(isUsable(token({ expiresAt: "2026-08-12T10:02:00.000Z" }), NOW)).toBe(false);
  });

  it("refuses one whose expiry is unreadable", () => {
    expect(isUsable(token({ expiresAt: "whenever" }), NOW)).toBe(false);
  });
});

describe("canRefresh", () => {
  it("is false without a refresh token, which is the ordinary case", () => {
    expect(canRefresh(token(), NOW)).toBe(false);
  });

  it("is true with one that has not itself expired", () => {
    expect(
      canRefresh(token({ refreshToken: "r", refreshExpiresAt: "2027-08-12T10:00:00.000Z" }), NOW),
    ).toBe(true);
  });

  it("is false once the refresh token has expired too", () => {
    expect(
      canRefresh(token({ refreshToken: "r", refreshExpiresAt: "2026-08-11T10:00:00.000Z" }), NOW),
    ).toBe(false);
  });

  it("tries a refresh token with no stated expiry rather than assuming it is dead", () => {
    expect(canRefresh(token({ refreshToken: "r" }), NOW)).toBe(true);
  });
});

describe("tokenFromGrant", () => {
  it("turns the relative expiry into an instant", () => {
    const stored = tokenFromGrant(
      { accessToken: "tok", expiresIn: 3600, refreshToken: null, refreshExpiresIn: null },
      "urn:li:person:abc123",
      null,
      NOW,
    );

    expect(stored.expiresAt).toBe("2026-08-12T11:00:00.000Z");
    expect(stored.connectedAt).toBe(NOW.toISOString());
  });

  // LinkedIn does not always reissue one on a refresh, and losing it would turn
  // a deployment that never needs a login back into one that does.
  it("keeps the previous refresh token when the refresh returns none", () => {
    const previous = token({ refreshToken: "old", refreshExpiresAt: "2027-08-12T10:00:00.000Z" });
    const stored = tokenFromGrant(
      { accessToken: "fresh", expiresIn: 3600, refreshToken: null, refreshExpiresIn: null },
      previous.authorUrn,
      previous,
      NOW,
    );

    expect(stored.refreshToken).toBe("old");
    expect(stored.refreshExpiresAt).toBe("2027-08-12T10:00:00.000Z");
  });

  it("does not date a new refresh token by the old one's expiry", () => {
    const previous = token({ refreshToken: "old", refreshExpiresAt: "2027-08-12T10:00:00.000Z" });
    const stored = tokenFromGrant(
      { accessToken: "fresh", expiresIn: 3600, refreshToken: "new", refreshExpiresIn: null },
      previous.authorUrn,
      previous,
      NOW,
    );

    expect(stored.refreshToken).toBe("new");
    expect(stored.refreshExpiresAt).toBeNull();
  });
});
