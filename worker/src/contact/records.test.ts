/**
 * The CSV records, and the conditional write that keeps two visitors from
 * writing over each other.
 *
 * The interesting case is not the happy one. It is two requests reading the
 * same file and both wanting to add a row: R2 refuses the second write because
 * the object moved on, and the retry has to keep the row it lost the race to
 * rather than replacing it.
 */
import { describe, expect, it } from "vitest";

import { createFakeBucket } from "../test-support/r2";
import { parseCsv } from "./csv";
import { appendRow, MESSAGES_KEY, readCsv, updateCsv } from "./records";

const rowsIn = (storage: ReturnType<typeof createFakeBucket>, key: string) =>
  parseCsv(storage.objects.get(key) ?? "");

describe("appending", () => {
  it("creates the file with the first row", async () => {
    const storage = createFakeBucket();

    await appendRow(storage.bucket, MESSAGES_KEY, ["a@example.com", "2026-08-11T05:00:00Z"]);

    expect(rowsIn(storage, MESSAGES_KEY)).toEqual([["a@example.com", "2026-08-11T05:00:00Z"]]);
  });

  it("keeps what was already there", async () => {
    const storage = createFakeBucket();

    await appendRow(storage.bucket, MESSAGES_KEY, ["first"]);
    await appendRow(storage.bucket, MESSAGES_KEY, ["second"]);

    expect(rowsIn(storage, MESSAGES_KEY)).toEqual([["first"], ["second"]]);
  });

  it("writes it under contact-records/, which nothing expires", () => {
    // contact/ is swept by the bucket's lifecycle rule within days, which is
    // right for a message in flight and would quietly delete these.
    expect(MESSAGES_KEY.startsWith("contact-records/")).toBe(true);
  });

  it("keeps a row that landed between the read and the write", async () => {
    const storage = createFakeBucket();
    await appendRow(storage.bucket, MESSAGES_KEY, ["first"]);

    // Somebody else's row arrives after this call has read the file and before
    // it writes: the conditional write is refused, and the retry sees both.
    storage.interceptPut(MESSAGES_KEY, async () => {
      await appendRow(storage.bucket, MESSAGES_KEY, ["interloper"]);
    });

    await appendRow(storage.bucket, MESSAGES_KEY, ["second"]);

    expect(rowsIn(storage, MESSAGES_KEY)).toEqual([["first"], ["interloper"], ["second"]]);
  });

  it("gives up rather than overwriting when it keeps losing the race", async () => {
    const storage = createFakeBucket();
    // Every conditional write is refused, which is what unbounded contention
    // would look like.
    const bucket = {
      ...storage.bucket,
      get: storage.bucket.get.bind(storage.bucket),
      put: async () => null,
    } as unknown as R2Bucket;

    await expect(appendRow(bucket, MESSAGES_KEY, ["never"])).rejects.toThrow(/without overwriting/);
  });
});

describe("reading", () => {
  it("finds nothing in a file that was never written", async () => {
    const storage = createFakeBucket();

    expect(await readCsv(storage.bucket, MESSAGES_KEY)).toEqual([]);
  });

  it("survives a message with commas, quotes and newlines in it", async () => {
    const storage = createFakeBucket();
    const text = 'Hello, "friend"\nsecond line';

    await appendRow(storage.bucket, MESSAGES_KEY, ["A Visitor", text]);

    expect((await readCsv(storage.bucket, MESSAGES_KEY))[0]).toEqual(["A Visitor", text]);
  });
});

describe("changing", () => {
  it("writes back exactly what the mutation returned", async () => {
    const storage = createFakeBucket();
    await appendRow(storage.bucket, MESSAGES_KEY, ["keep"]);
    await appendRow(storage.bucket, MESSAGES_KEY, ["drop"]);

    await updateCsv(storage.bucket, MESSAGES_KEY, (rows) => rows.filter((row) => row[0] !== "drop"));

    expect(rowsIn(storage, MESSAGES_KEY)).toEqual([["keep"]]);
  });
});
