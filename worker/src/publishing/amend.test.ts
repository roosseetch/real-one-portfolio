import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHUNK_CACHE_CONTROL, chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { amendRecord } from "./amend";

let content: FakeBucket;

function env() {
  return { CONTENT_BUCKET: content.bucket };
}

function record(id: string, title: string): PublicRecord {
  return {
    id,
    title,
    summary: null,
    body: null,
    eventDate: null,
    publishedAt: "2026-08-10T09:00:00.000Z",
    tags: [],
    media: [],
  };
}

/** Lays down chunks and the manifest that points at them, as publication would have. */
function publish(chunks: PublicRecord[][]): Manifest {
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

  return manifest;
}

function manifest(): Manifest {
  return JSON.parse(content.objects.get(MANIFEST_KEY) as string) as Manifest;
}

function chunkOf(id: string): PublicRecord[] {
  return JSON.parse(content.objects.get(chunkKey(id)) as string) as PublicRecord[];
}

const retitle = (title: string) => (record: PublicRecord) => ({ ...record, title });

beforeEach(() => {
  content = createFakeBucket();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("amendRecord", () => {
  it("republishes the holding chunk under a new id rather than editing it", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First"), record("bbbbbbbbbbbbbbbb", "Second")]]);

    const result = await amendRecord(env(), "bbbbbbbbbbbbbbbb", retitle("Renamed"));
    expect(result.status).toBe("amended");

    // The old chunk is untouched, which is what lets it stay cached for a year.
    expect(chunkOf("chunk0").map((r) => r.title)).toEqual(["First", "Second"]);

    const entry = manifest().records[0];
    expect(entry.id).not.toBe("chunk0");
    expect(chunkOf(entry.id).map((r) => r.title)).toEqual(["First", "Renamed"]);
  });

  it("keeps every other record in the chunk, in order", async () => {
    publish([
      [record("aaaaaaaaaaaaaaaa", "First"), record("bbbbbbbbbbbbbbbb", "Second"), record("cccccccccccccccc", "Third")],
    ]);

    await amendRecord(env(), "bbbbbbbbbbbbbbbb", retitle("Renamed"));

    expect(chunkOf(manifest().records[0].id).map((r) => r.id)).toEqual([
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
      "cccccccccccccccc",
    ]);
  });

  it("serves the new chunk with the immutable cache header every chunk gets", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First")]]);

    await amendRecord(env(), "aaaaaaaaaaaaaaaa", retitle("Renamed"));

    expect(content.cacheControl(chunkKey(manifest().records[0].id))).toBe(CHUNK_CACHE_CONTROL);
  });

  it("repoints `latest` only when the chunk it names is the one rewritten", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "Old")], [record("bbbbbbbbbbbbbbbb", "New")]]);

    // An older chunk: `latest` must keep naming the newest, or the next
    // publication appends to an archive chunk and records arrive out of order.
    await amendRecord(env(), "aaaaaaaaaaaaaaaa", retitle("Renamed"));
    expect(manifest().latest).toBe("chunk1");

    await amendRecord(env(), "bbbbbbbbbbbbbbbb", retitle("Also renamed"));
    expect(manifest().latest).toBe(manifest().records[1].id);
    expect(manifest().latest).not.toBe("chunk1");
  });

  it("leaves the count and the digest describing what the new chunk holds", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First"), record("bbbbbbbbbbbbbbbb", "Second")]]);

    await amendRecord(env(), "aaaaaaaaaaaaaaaa", (r) => ({ ...r, media: [] }));

    const entry = manifest().records[0];
    expect(entry.count).toBe(2);
    expect(entry.sha256).not.toBe("x");
  });

  it("finds a record in an older chunk", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "Old")], [record("bbbbbbbbbbbbbbbb", "New")]]);

    const result = await amendRecord(env(), "aaaaaaaaaaaaaaaa", retitle("Renamed"));

    expect(result.status).toBe("amended");
    expect(chunkOf(manifest().records[0].id)[0].title).toBe("Renamed");
    // Untouched.
    expect(manifest().records[1].id).toBe("chunk1");
  });

  it("reports a record that is nowhere without writing anything", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First")]]);
    const before = content.objects.size;

    const result = await amendRecord(env(), "zzzzzzzzzzzzzzzz", retitle("Renamed"));

    expect(result).toEqual({ status: "failed", reason: "not-found" });
    expect(content.objects.size).toBe(before);
  });

  it("refuses an id that could never name a record", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First")]]);

    // Slashes and dots are what `isValidId` exists to keep out of a key.
    expect(await amendRecord(env(), "../../etc", retitle("x"))).toEqual({
      status: "failed",
      reason: "not-found",
    });
  });

  it("writes nothing when the amendment changes nothing", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First")]]);
    const before = content.objects.size;

    const result = await amendRecord(env(), "aaaaaaaaaaaaaaaa", (r) => r);

    expect(result.status).toBe("unchanged");
    expect(content.objects.size).toBe(before);
    expect(manifest().records[0].id).toBe("chunk0");
  });

  it("refuses to invent a history when there is no manifest", async () => {
    const result = await amendRecord(env(), "aaaaaaaaaaaaaaaa", retitle("Renamed"));
    expect(result).toEqual({ status: "failed", reason: "no-manifest" });
  });

  it("leaves the site as it was when the chunk cannot be written", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First")]]);
    content.failPutsFor((key) => key !== MANIFEST_KEY);

    const result = await amendRecord(env(), "aaaaaaaaaaaaaaaa", retitle("Renamed"));

    expect(result).toEqual({ status: "failed", reason: "storage" });
    expect(chunkOf("chunk0")[0].title).toBe("First");
    expect(manifest().records[0].id).toBe("chunk0");
  });

  /**
   * The whole reason the manifest write is conditional. A publication landing
   * between the read and the write must not be clobbered by an amendment that
   * never saw it.
   */
  it("rebuilds against a manifest that changed underneath it", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First")]]);

    content.interceptPut(MANIFEST_KEY, () => {
      content.objects.set(chunkKey("chunk9"), JSON.stringify([record("cccccccccccccccc", "Landed meanwhile")]));
      content.objects.set(
        MANIFEST_KEY,
        JSON.stringify({
          ...manifest(),
          records: [...manifest().records, { id: "chunk9", sha256: "y", count: 1 }],
          latest: "chunk9",
          totalRecords: 2,
        }),
      );
    });

    const result = await amendRecord(env(), "aaaaaaaaaaaaaaaa", retitle("Renamed"));

    expect(result.status).toBe("amended");

    const after = manifest();
    expect(after.records).toHaveLength(2);
    // The record that landed meanwhile survived, and still is `latest`.
    expect(after.latest).toBe("chunk9");
    expect(chunkOf(after.records[0].id)[0].title).toBe("Renamed");
    expect(chunkOf("chunk9")[0].title).toBe("Landed meanwhile");
  });

  it("gives up loudly rather than spinning on a manifest that never settles", async () => {
    publish([[record("aaaaaaaaaaaaaaaa", "First")]]);

    const bump = () => {
      content.objects.set(MANIFEST_KEY, content.objects.get(MANIFEST_KEY) as string);
      content.interceptPut(MANIFEST_KEY, bump);
    };
    content.interceptPut(MANIFEST_KEY, bump);

    const result = await amendRecord(env(), "aaaaaaaaaaaaaaaa", retitle("Renamed"));

    expect(result).toEqual({ status: "failed", reason: "conflict" });
    expect(chunkOf("chunk0")[0].title).toBe("First");
  });
});
