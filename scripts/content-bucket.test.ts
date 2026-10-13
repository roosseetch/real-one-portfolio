import { describe, expect, it } from "vitest";

import { type Manifest, isRecordId, manifestWith, problemsWith, rolls } from "./content-bucket.js";

const manifest = (counts: number[]): Manifest => ({
  schemaVersion: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
  recordsPerFile: 10,
  totalRecords: counts.reduce((a, b) => a + b, 0),
  records: counts.map((count, index) => ({ id: `c${index}`, sha256: "0".repeat(64), count })),
  latest: counts.length ? `c${counts.length - 1}` : null,
});

const now = new Date("2026-10-13T12:00:00.000Z");

describe("where a hand-published record goes", () => {
  it("replaces the latest chunk while it has room", () => {
    const before = manifest([10, 4]);
    expect(rolls(before)).toBe(false);

    const after = manifestWith(before, { id: "n", sha256: "1".repeat(64), count: 5 }, false, now);
    expect(after.records.map((chunk) => chunk.id)).toEqual(["c0", "n"]);
    expect(after.totalRecords).toBe(15);
    expect(after.latest).toBe("n");
    expect(after.updatedAt).toBe(now.toISOString());
  });

  it("starts a new chunk when the latest is full, or there is none", () => {
    expect(rolls(manifest([10]))).toBe(true);
    expect(rolls(manifest([]))).toBe(true);

    const after = manifestWith(manifest([10]), { id: "n", sha256: "1".repeat(64), count: 1 }, true, now);
    expect(after.records.map((chunk) => chunk.id)).toEqual(["c0", "n"]);
    expect(after.totalRecords).toBe(11);
  });
});

describe("a record written by hand", () => {
  const good = {
    title: "SCOPE Europe 2026",
    summary: "Three workshops.",
    body: "## Workshop 1",
    bodyFormat: "markdown",
    eventDate: "2026-10-12",
    tags: ["Conference"],
    media: [{ type: "image", src: "https://media.test/x-1024.webp" }],
  };

  it("passes when it is the shape the site reads", () => {
    expect(problemsWith(good)).toEqual([]);
  });

  it("names every problem rather than the first", () => {
    expect(
      problemsWith({ ...good, title: "", eventDate: "12 Oct", bodyFormat: "html", media: [{ type: "gif", src: "http://media.test/x-1024.webp" }] }),
    ).toHaveLength(5);
  });

  /** Where a record is and when it went live are the script's to say. */
  it("refuses an id or publishedAt typed into the file", () => {
    expect(problemsWith({ ...good, id: "x", publishedAt: "2026-01-01" })).toHaveLength(2);
  });

  it("checks an id the way the Worker mints them", () => {
    expect(isRecordId("0123456789abcdef")).toBe(true);
    expect(isRecordId("0123456789abcdei")).toBe(false);
    expect(isRecordId("short")).toBe(false);
  });
});
