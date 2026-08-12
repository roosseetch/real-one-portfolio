import { beforeEach, describe, expect, it } from "vitest";

import { chunkKey } from "./chunks";
import { MANIFEST_KEY, type Manifest } from "./manifest";
import { findByReference, findRecord, loadRecords, referenceFrom } from "./recent";
import type { PublicRecord } from "./records";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";

let content: FakeBucket;

function env() {
  return { CONTENT_BUCKET: content.bucket };
}

function record(id: string, title: string, publishedAt: string | null = "2026-08-10T09:00:00.000Z"): PublicRecord {
  return {
    id,
    title,
    summary: null,
    body: null,
    eventDate: null,
    publishedAt: publishedAt as string,
    tags: [],
    media: [],
  };
}

function publish(chunks: PublicRecord[][]): void {
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

beforeEach(() => {
  content = createFakeBucket();
});

describe("loadRecords", () => {
  it("reads back from the newest chunk and stops once it has enough", async () => {
    publish([
      [record("aaaaaaaaaaaaaaaa", "Oldest", "2026-08-01T09:00:00.000Z")],
      [record("bbbbbbbbbbbbbbbb", "Newer", "2026-08-05T09:00:00.000Z")],
    ]);

    expect((await loadRecords(env(), 1, 3)).map((r) => r.title)).toEqual(["Newer"]);
  });

  it("answers nothing at all before anything is published", async () => {
    expect(await loadRecords(env(), 5, 2)).toEqual([]);
  });
});

describe("findRecord", () => {
  it("finds one by id across chunks", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "Old")], [record("bbbbbbbbbbbbbbbb", "New")]]);

    expect((await findRecord(env(), "aaaaaaaaaaaaaaaa"))?.title).toBe("Old");
    expect(await findRecord(env(), "zzzzzzzzzzzzzzzz")).toBeNull();
  });

  it("refuses an id that could never be one of ours", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "Old")]]);
    expect(await findRecord(env(), "../../etc")).toBeNull();
  });
});

describe("referenceFrom", () => {
  /**
   * The bot sends a link after every publication, so a pasted link is the thing
   * nearest to hand when the author is asked which activity they mean.
   */
  it("takes the slug out of a link the bot sent", () => {
    expect(referenceFrom("https://site.example/activities/?v=a-morning-run")).toBe("a-morning-run");
  });

  it("is not fooled by another parameter or a fragment", () => {
    expect(referenceFrom("https://site.example/activities/?utm=x&v=a-morning-run#top")).toBe("a-morning-run");
  });

  it("takes an id or a slug typed on its own", () => {
    expect(referenceFrom("  aaaaaaaaaaaaaaaa  ")).toBe("aaaaaaaaaaaaaaaa");
    expect(referenceFrom("a-morning-run")).toBe("a-morning-run");
  });

  // A link with no ?v= names the feed, so searching for the whole URL as a slug
  // could only ever fail to match. Saying so is better than pretending to look.
  it("names nothing when a link names no entry", () => {
    expect(referenceFrom("https://site.example/activities/")).toBe("");
  });
});

describe("findByReference", () => {
  beforeEach(() => {
    publish([[record("aaaaaaaaaaaaaaaa", "A morning run"), record("bbbbbbbbbbbbbbbb", "Another day")]]);
  });

  it("finds one by the slug in a pasted link", async () => {
    const found = await findByReference(env(), "https://site.example/activities/?v=a-morning-run");
    expect(found?.id).toBe("aaaaaaaaaaaaaaaa");
  });

  it("finds one by its slug alone, and by its id", async () => {
    expect((await findByReference(env(), "another-day"))?.id).toBe("bbbbbbbbbbbbbbbb");
    expect((await findByReference(env(), "bbbbbbbbbbbbbbbb"))?.id).toBe("bbbbbbbbbbbbbbbb");
  });

  it("finds nothing for a link to the feed, or for a slug nobody has", async () => {
    expect(await findByReference(env(), "https://site.example/activities/")).toBeNull();
    expect(await findByReference(env(), "a-run-that-never-happened")).toBeNull();
    expect(await findByReference(env(), "   ")).toBeNull();
  });

  /**
   * The id wins over a slug, so a title that happens to slug to another record's
   * id cannot shadow the record that id names.
   */
  it("prefers an exact id to a matching slug", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"), record("bbbbbbbbbbbbbbbb", "Another day")]]);

    expect((await findByReference(env(), "bbbbbbbbbbbbbbbb"))?.title).toBe("Another day");
  });
});
