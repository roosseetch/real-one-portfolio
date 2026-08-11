/**
 * What the browser remembers between visits.
 *
 * Two things matter here and neither is the happy path: that the address is not
 * left lying about in the open, and that every way storage can fail ends in a
 * visitor typing a code rather than in an exception halfway through a form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { forget, recall, remember } from "./verified-store";

const EMAIL = "visitor@example.com";
const TOKEN = "0123456789abcdefghjkmnpqrstvwxyz";
const DAY = 24 * 60 * 60 * 1000;

const stored = () => JSON.parse(localStorage.getItem("contact.verified.v1") ?? "{}");

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("remembering", () => {
  it("gives the token back for the address it was kept under", async () => {
    await remember(EMAIL, TOKEN);

    expect(await recall(EMAIL)).toBe(TOKEN);
  });

  it("knows nothing about an address it was never given", async () => {
    await remember(EMAIL, TOKEN);

    expect(await recall("someone@example.com")).toBeNull();
  });

  it("treats an address as the same inbox whatever its case or spacing", async () => {
    await remember("  Visitor@Example.com ", TOKEN);

    expect(await recall(EMAIL)).toBe(TOKEN);
  });

  it("never writes the address down in the open", async () => {
    await remember(EMAIL, TOKEN);

    // What somebody reading this browser's storage can see: an opaque key, and
    // a token that is useless without the address it belongs to.
    const raw = localStorage.getItem("contact.verified.v1") as string;
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain("visitor");
    expect(raw).not.toContain("example.com");
    expect(Object.keys(stored())[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps more than one address at once", async () => {
    await remember(EMAIL, TOKEN);
    await remember("someone@example.com", "zzzz456789abcdefghjkmnpqrstvwxyz");

    expect(await recall(EMAIL)).toBe(TOKEN);
    expect(await recall("someone@example.com")).toBe("zzzz456789abcdefghjkmnpqrstvwxyz");
  });
});

describe("expiring", () => {
  it("still answers a day before the month is up", async () => {
    const now = Date.now();
    await remember(EMAIL, TOKEN, now);

    expect(await recall(EMAIL, now + 29 * DAY)).toBe(TOKEN);
  });

  it("says nothing a day after", async () => {
    const now = Date.now();
    await remember(EMAIL, TOKEN, now);

    expect(await recall(EMAIL, now + 31 * DAY)).toBeNull();
  });

  it("clears out what has expired when something new is kept", async () => {
    const now = Date.now();
    await remember("old@example.com", TOKEN, now);

    await remember(EMAIL, TOKEN, now + 31 * DAY);

    expect(Object.keys(stored())).toHaveLength(1);
  });
});

describe("forgetting", () => {
  it("drops the address the Worker refused", async () => {
    await remember(EMAIL, TOKEN);

    await forget(EMAIL);

    expect(await recall(EMAIL)).toBeNull();
  });

  it("leaves every other address alone", async () => {
    await remember(EMAIL, TOKEN);
    await remember("someone@example.com", TOKEN);

    await forget(EMAIL);

    expect(await recall("someone@example.com")).toBe(TOKEN);
  });
});

describe("when storage will not cooperate", () => {
  it("recalls nothing rather than throwing when the value is not JSON", async () => {
    localStorage.setItem("contact.verified.v1", "{not json");

    expect(await recall(EMAIL)).toBeNull();
  });

  it("ignores an entry somebody edited into the wrong shape", async () => {
    await remember(EMAIL, TOKEN);
    const key = Object.keys(stored())[0];
    localStorage.setItem("contact.verified.v1", JSON.stringify({ [key]: { token: 42 } }));

    expect(await recall(EMAIL)).toBeNull();
  });

  it("carries on when writing is refused, as in a private window", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    // The visitor types a code next time, which is the same thing that happens
    // on a first visit and needs no explaining.
    await expect(remember(EMAIL, TOKEN)).resolves.toBeUndefined();
  });

  it("carries on when reading is refused", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(await recall(EMAIL)).toBeNull();
  });
});
