import { describe, expect, it } from "vitest";

import { randomId } from "./ids";

describe("randomId", () => {
  it("defaults to 16 characters", () => {
    expect(randomId()).toHaveLength(16);
  });

  it("honours a requested length", () => {
    expect(randomId(7)).toHaveLength(7);
    expect(randomId(32)).toHaveLength(32);
  });

  it("uses only Crockford base32 characters", () => {
    // i, l, o and u are excluded so an ID read aloud or copied by hand cannot
    // come back as a different one.
    for (let i = 0; i < 200; i++) {
      expect(randomId()).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]+$/);
    }
  });

  it("does not repeat itself", () => {
    // Sequential IDs would make drafts and, later, public record chunks
    // enumerable by anyone who saw one.
    const ids = new Set(Array.from({ length: 1000 }, () => randomId()));
    expect(ids.size).toBe(1000);
  });

  it("spreads across the alphabet rather than favouring its start", () => {
    // A modulo over an alphabet that does not divide 256 would quietly bias
    // the early characters; 32 divides 256, and this notices if that changes.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const char of randomId()) seen.add(char);
    expect(seen.size).toBe(32);
  });
});
