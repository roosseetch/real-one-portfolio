/**
 * Verification codes: issuing, redeeming, expiring, and the cleaning that
 * happens because somebody asked for a code rather than because a timer fired.
 *
 * Time is passed in rather than mocked. Every function here takes `now`, which
 * is what makes "thirty minutes later" a parameter instead of a wait.
 */
import { describe, expect, it } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import {
  CODE_TTL_MS,
  isVerified,
  issueCode,
  MAX_ATTEMPTS,
  MAX_LIVE_CODES,
  newCode,
  recordMessage,
  recordVerification,
  redeemCode,
  VERIFIED_TTL_MS,
} from "./codes";
import { parseCsv } from "./csv";
import { CODES_KEY, MESSAGES_KEY, VERIFIED_KEY } from "./records";

const START = new Date("2026-08-11T05:00:00.000Z");
const later = (ms: number) => new Date(START.getTime() + ms);

const codes = (storage: FakeBucket) => parseCsv(storage.objects.get(CODES_KEY) ?? "");
const verified = (storage: FakeBucket) => parseCsv(storage.objects.get(VERIFIED_KEY) ?? "");

/** Issues a code and hands back what was mailed, for a test that has to type it. */
async function issued(storage: FakeBucket, email: string, at = START): Promise<string> {
  const outcome = await issueCode(storage.bucket, email, at);
  if (outcome.status !== "issued") throw new Error(`expected a code, got ${outcome.status}`);
  return outcome.code;
}

describe("the code itself", () => {
  it("is always six digits", () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });

  it("is not the same one every time", () => {
    const seen = new Set(Array.from({ length: 50 }, newCode));

    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("issuing", () => {
  it("records the address, the code, when it was issued, and no attempts yet", async () => {
    const storage = createFakeBucket();

    const code = await issued(storage, "visitor@example.com");

    expect(codes(storage)).toEqual([["visitor@example.com", code, START.toISOString(), "0"]]);
  });

  it("treats an address as the same inbox whatever its case", async () => {
    const storage = createFakeBucket();

    await issued(storage, "Visitor@Example.com");

    expect(codes(storage)[0][0]).toBe("visitor@example.com");
  });

  it("keeps an earlier code alive when a second is asked for", async () => {
    const storage = createFakeBucket();

    const first = await issued(storage, "visitor@example.com");
    const second = await issued(storage, "visitor@example.com", later(60_000));

    expect(codes(storage)).toHaveLength(2);
    expect((await redeemCode(storage.bucket, "visitor@example.com", first, later(120_000))).outcome).toBe("accepted");
    expect(second).not.toBe("");
  });

  it("refuses to hold more than a handful of live codes for one address", async () => {
    const storage = createFakeBucket();
    for (let i = 0; i < MAX_LIVE_CODES; i++) await issued(storage, "visitor@example.com", later(i * 1000));

    const extra = await issueCode(storage.bucket, "visitor@example.com", later(MAX_LIVE_CODES * 1000));

    expect(extra.status).toBe("too-many");
    expect(codes(storage)).toHaveLength(MAX_LIVE_CODES);
  });

  it("counts addresses separately", async () => {
    const storage = createFakeBucket();
    for (let i = 0; i < MAX_LIVE_CODES; i++) await issued(storage, "visitor@example.com", later(i * 1000));

    const other = await issueCode(storage.bucket, "someone@example.com", later(10_000));

    expect(other.status).toBe("issued");
  });
});

describe("the cleaning that happens on the way past", () => {
  it("drops lines that have aged out, oldest first, when a new code is asked for", async () => {
    const storage = createFakeBucket();
    await issued(storage, "old@example.com");
    await issued(storage, "newer@example.com", later(CODE_TTL_MS - 1000));

    // Far enough on that the first has expired and the second has not.
    await issued(storage, "latest@example.com", later(CODE_TTL_MS + 1000));

    expect(codes(storage).map((row) => row[0])).toEqual(["newer@example.com", "latest@example.com"]);
  });

  it("stops at the first line that is still live, and leaves the rest alone", async () => {
    const storage = createFakeBucket();
    await issued(storage, "live@example.com", later(CODE_TTL_MS));
    // Older than the line above it, but behind it in the file.
    await storage.bucket.put(CODES_KEY, `live@example.com,111111,${later(CODE_TTL_MS).toISOString()},0\r\nstale@example.com,222222,${START.toISOString()},0\r\n`);

    await issued(storage, "next@example.com", later(CODE_TTL_MS + 1000));

    // The stale line survives: cleaning only walks the head, which is what
    // keeps it cheap. It cannot be redeemed either way.
    expect(codes(storage).map((row) => row[0])).toEqual([
      "live@example.com",
      "stale@example.com",
      "next@example.com",
    ]);
  });

  it("needs no timer to keep the file from growing without bound", async () => {
    const storage = createFakeBucket();
    for (let i = 0; i < 20; i++) await issued(storage, `visitor${i}@example.com`, later(i * 60_000));

    // An hour later, everything above has aged out.
    await issued(storage, "last@example.com", later(20 * 60_000 + CODE_TTL_MS));

    expect(codes(storage)).toHaveLength(1);
  });
});

describe("redeeming", () => {
  it("accepts the code that was sent, and records the address as verified", async () => {
    const storage = createFakeBucket();
    const code = await issued(storage, "visitor@example.com");

    const redeemed = await redeemCode(storage.bucket, "visitor@example.com", code, later(1000));

    expect(redeemed.outcome).toBe("accepted");
    expect(verified(storage)).toEqual([
      ["visitor@example.com", later(1000).toISOString(), redeemed.token],
    ]);
  });

  it("hands back a token, and only when the code was right", async () => {
    const storage = createFakeBucket();
    const code = await issued(storage, "visitor@example.com");
    const wrong = code === "000000" ? "111111" : "000000";

    const refused = await redeemCode(storage.bucket, "visitor@example.com", wrong, later(1000));
    const accepted = await redeemCode(storage.bucket, "visitor@example.com", code, later(2000));

    expect(refused.token).toBeNull();
    expect(accepted.token).toMatch(/^[0-9a-z]{32}$/);
  });

  it("spends every code the address held, not just the one typed", async () => {
    const storage = createFakeBucket();
    const first = await issued(storage, "visitor@example.com");
    await issued(storage, "visitor@example.com", later(1000));

    await redeemCode(storage.bucket, "visitor@example.com", first, later(2000));

    expect(codes(storage)).toEqual([]);
  });

  it("refuses a code that is not the one sent", async () => {
    const storage = createFakeBucket();
    const code = await issued(storage, "visitor@example.com");
    const wrong = code === "000000" ? "111111" : "000000";

    expect((await redeemCode(storage.bucket, "visitor@example.com", wrong, later(1000))).outcome).toBe("rejected");
    expect(verified(storage)).toEqual([]);
  });

  it("says the same thing about an address that was never sent one", async () => {
    const storage = createFakeBucket();

    expect((await redeemCode(storage.bucket, "stranger@example.com", "123456")).outcome).toBe("none");
  });

  it("dies after three wrong guesses, whatever the fourth says", async () => {
    const storage = createFakeBucket();
    const code = await issued(storage, "visitor@example.com");
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect((await redeemCode(storage.bucket, "visitor@example.com", wrong, later(1000))).outcome).toBe("rejected");
    }

    // The right code, and too late: the attempts are spent.
    expect((await redeemCode(storage.bucket, "visitor@example.com", code, later(1000))).outcome).toBe("none");
  });

  it("charges a wrong guess to every live code, so holding several buys no extra tries", async () => {
    const storage = createFakeBucket();
    const first = await issued(storage, "visitor@example.com");
    await issued(storage, "visitor@example.com", later(1000));
    const wrong = first === "000000" ? "111111" : "000000";

    for (let i = 0; i < MAX_ATTEMPTS; i++) await redeemCode(storage.bucket, "visitor@example.com", wrong, later(2000));

    expect((await redeemCode(storage.bucket, "visitor@example.com", first, later(2000))).outcome).toBe("none");
  });

  it("refuses a code that has aged out", async () => {
    const storage = createFakeBucket();
    const code = await issued(storage, "visitor@example.com");

    expect((await redeemCode(storage.bucket, "visitor@example.com", code, later(CODE_TTL_MS + 1))).outcome).toBe("none");
  });

  it("accepts one a minute before it ages out", async () => {
    const storage = createFakeBucket();
    const code = await issued(storage, "visitor@example.com");

    expect((await redeemCode(storage.bucket, "visitor@example.com", code, later(CODE_TTL_MS - 60_000))).outcome).toBe(
      "accepted",
    );
  });

  it("does not let one address redeem another's code", async () => {
    const storage = createFakeBucket();
    const code = await issued(storage, "visitor@example.com");

    expect((await redeemCode(storage.bucket, "someone@example.com", code, later(1000))).outcome).toBe("none");
  });
});

describe("staying verified", () => {
  it("is verified inside the window, by the browser holding the token", async () => {
    const storage = createFakeBucket();
    const token = await recordVerification(storage.bucket, "visitor@example.com", START);

    expect(await isVerified(storage.bucket, "visitor@example.com", token, later(VERIFIED_TTL_MS - 1000))).toBe(
      true,
    );
  });

  it("is not verified after it", async () => {
    const storage = createFakeBucket();
    const token = await recordVerification(storage.bucket, "visitor@example.com", START);

    expect(await isVerified(storage.bucket, "visitor@example.com", token, later(VERIFIED_TTL_MS + 1000))).toBe(
      false,
    );
  });

  it("has never been verified when it is not in the file", async () => {
    const storage = createFakeBucket();

    expect(await isVerified(storage.bucket, "stranger@example.com", "whatever", START)).toBe(false);
  });

  it("refuses somebody who knows the address but holds no token", async () => {
    // The whole point of the token. Without it, "this address verified itself
    // three weeks ago" would be a fact anybody could trade on.
    const storage = createFakeBucket();
    await recordVerification(storage.bucket, "visitor@example.com", START);

    expect(await isVerified(storage.bucket, "visitor@example.com", "", later(1000))).toBe(false);
    expect(await isVerified(storage.bucket, "visitor@example.com", "not-the-token", later(1000))).toBe(false);
  });

  it("refuses a token that belongs to a different address", async () => {
    const storage = createFakeBucket();
    const mine = await recordVerification(storage.bucket, "visitor@example.com", START);
    await recordVerification(storage.bucket, "someone@example.com", START);

    expect(await isVerified(storage.bucket, "someone@example.com", mine, later(1000))).toBe(false);
  });

  it("retires the previous token when the address verifies again", async () => {
    // Verifying on a second machine signs the first one out, rather than
    // leaving two live claims on one address.
    const storage = createFakeBucket();
    const first = await recordVerification(storage.bucket, "visitor@example.com", START);
    const second = await recordVerification(storage.bucket, "visitor@example.com", later(60_000));

    expect(await isVerified(storage.bucket, "visitor@example.com", first, later(61_000))).toBe(false);
    expect(await isVerified(storage.bucket, "visitor@example.com", second, later(61_000))).toBe(true);
  });

  it("cannot be satisfied by a row written before tokens existed", async () => {
    // Two columns, as the file looked yesterday. It proves the address was
    // verified once and nothing about who is asking now.
    const storage = createFakeBucket();
    await storage.bucket.put(VERIFIED_KEY, `visitor@example.com,${START.toISOString()}\r\n`);

    expect(await isVerified(storage.bucket, "visitor@example.com", "", later(1000))).toBe(false);
    expect(await isVerified(storage.bucket, "visitor@example.com", "anything", later(1000))).toBe(false);
  });

  it("keeps one line per address rather than a log of how often somebody writes", async () => {
    const storage = createFakeBucket();

    await recordVerification(storage.bucket, "visitor@example.com", START);
    const second = await recordVerification(storage.bucket, "visitor@example.com", later(60_000));

    expect(verified(storage)).toEqual([["visitor@example.com", later(60_000).toISOString(), second]]);
  });
});

describe("the message record", () => {
  it("writes every field of the form, and when it was sent", async () => {
    const storage = createFakeBucket();

    await recordMessage(
      storage.bucket,
      {
        name: "A Visitor",
        email: "visitor@example.com",
        company: "Acme Research",
        phone: "+44 20 7946 0958",
        text: "Hello, I would like to talk about a project.",
      },
      START,
    );

    expect(parseCsv(storage.objects.get(MESSAGES_KEY) ?? "")).toEqual([
      [
        "A Visitor",
        "visitor@example.com",
        "Acme Research",
        "+44 20 7946 0958",
        "Hello, I would like to talk about a project.",
        START.toISOString(),
      ],
    ]);
  });

  it("leaves the optional columns empty rather than absent, so every row has the same shape", async () => {
    const storage = createFakeBucket();

    await recordMessage(
      storage.bucket,
      { name: "A Visitor", email: "visitor@example.com", text: "A message with no company and no number." },
      START,
    );

    expect(parseCsv(storage.objects.get(MESSAGES_KEY) ?? "")[0]).toHaveLength(6);
  });

  it("cannot have its columns rearranged by what somebody typed", async () => {
    const storage = createFakeBucket();

    await recordMessage(
      storage.bucket,
      {
        name: 'A Visitor","evil@example.com',
        email: "visitor@example.com",
        text: "Line one\r\nLine two, with a comma",
      },
      START,
    );

    const rows = parseCsv(storage.objects.get(MESSAGES_KEY) ?? "");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(6);
    expect(rows[0][0]).toBe('A Visitor","evil@example.com');
  });
});
