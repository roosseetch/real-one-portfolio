import { beforeEach, describe, expect, it } from "vitest";

import { CHUNK_CACHE_CONTROL, chunkKey } from "../content/chunks";
import {
  MANIFEST_CACHE_CONTROL,
  MANIFEST_KEY,
  RECORDS_PER_FILE,
  createManifest,
  emptyManifest,
  readManifest,
  type Manifest,
} from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { publishRecord } from "./publish";

let content: FakeBucket;

beforeEach(async () => {
  content = createFakeBucket();
  await createManifest(content.bucket, emptyManifest());
});

function record(title: string): PublicRecord {
  return { id: `id-${title}`, title, summary: null, body: null, eventDate: null, tags: [], media: [] };
}

const env = () => ({ CONTENT_BUCKET: content.bucket });

async function manifest(): Promise<Manifest> {
  const loaded = await readManifest(content.bucket);
  if (loaded === null) throw new Error("no manifest");
  return loaded.manifest;
}

async function chunk(id: string): Promise<PublicRecord[]> {
  return JSON.parse(content.objects.get(chunkKey(id)) as unknown as string);
}

/** Publishes n records one after another, as the author would. */
async function publishMany(n: number) {
  for (let i = 1; i <= n; i++) {
    const result = await publishRecord(env(), record(`entry ${i}`));
    if (result.status !== "published") throw new Error(`publish ${i} failed`);
  }
}

describe("publishing the first record", () => {
  it("writes a chunk and points the manifest at it", async () => {
    const result = await publishRecord(env(), record("first"));

    expect(result.status).toBe("published");
    if (result.status !== "published") return;

    const m = await manifest();
    expect(m.latest).toBe(result.chunkId);
    expect(m.records).toEqual([{ id: result.chunkId, sha256: expect.any(String), count: 1 }]);
    expect(m.totalRecords).toBe(1);
    expect(await chunk(result.chunkId)).toHaveLength(1);
  });

  it("stores chunk ids, never filenames", async () => {
    // Spec §9.2: the site derives records-{id}.json itself.
    const result = await publishRecord(env(), record("first"));
    const m = await manifest();

    expect(JSON.stringify(m)).not.toContain("records-");
    expect(JSON.stringify(m)).not.toContain(".json");
    if (result.status === "published") {
      expect(content.objects.has(chunkKey(result.chunkId))).toBe(true);
    }
  });

  it("caches chunks forever and the manifest never", async () => {
    // Spec §9.6. A chunk is immutable; a stale manifest hides records.
    const result = await publishRecord(env(), record("first"));
    if (result.status !== "published") throw new Error("expected publication");

    expect(content.cacheControl(chunkKey(result.chunkId))).toBe(CHUNK_CACHE_CONTROL);
    expect(content.cacheControl(chunkKey(result.chunkId))).toContain("immutable");
    expect(content.cacheControl(MANIFEST_KEY)).toBe(MANIFEST_CACHE_CONTROL);
  });

  it("refuses to publish when the bucket has no manifest", async () => {
    // A Worker pointed at the wrong bucket must fail where someone notices,
    // not quietly start a second history.
    const empty = createFakeBucket();
    const result = await publishRecord({ CONTENT_BUCKET: empty.bucket }, record("first"));

    expect(result).toEqual({ status: "failed", reason: "no-manifest" });
    expect(empty.objects.size).toBe(0);
  });
});

describe("appending to a chunk that is not full", () => {
  it("rewrites the chunk under a new id rather than editing it", async () => {
    // Chunks are immutable: that is what lets them be cached for a year.
    const first = await publishRecord(env(), record("first"));
    if (first.status !== "published") throw new Error("expected publication");

    const second = await publishRecord(env(), record("second"));
    if (second.status !== "published") throw new Error("expected publication");

    expect(second.chunkId).not.toBe(first.chunkId);
    expect(await chunk(second.chunkId)).toHaveLength(2);
    // The superseded chunk is left in place, unreferenced.
    expect(await chunk(first.chunkId)).toHaveLength(1);
  });

  it("replaces the manifest entry instead of adding one", async () => {
    await publishMany(2);
    const m = await manifest();

    expect(m.records).toHaveLength(1);
    expect(m.records[0].count).toBe(2);
    expect(m.totalRecords).toBe(2);
    expect(m.latest).toBe(m.records[0].id);
  });

  it("keeps entries in the order they were written", async () => {
    await publishMany(3);
    const m = await manifest();

    expect((await chunk(m.latest!)).map((r) => r.title)).toEqual(["entry 1", "entry 2", "entry 3"]);
  });
});

describe("rolling a new chunk", () => {
  it("starts one once the latest holds ten records", async () => {
    await publishMany(RECORDS_PER_FILE);
    const full = await manifest();
    expect(full.records).toHaveLength(1);
    expect(full.records[0].count).toBe(RECORDS_PER_FILE);

    await publishRecord(env(), record("eleventh"));
    const rolled = await manifest();

    expect(rolled.records).toHaveLength(2);
    expect(rolled.records[1].count).toBe(1);
    expect(rolled.latest).toBe(rolled.records[1].id);
    expect(rolled.totalRecords).toBe(RECORDS_PER_FILE + 1);
  });

  it("leaves the sealed chunk untouched", async () => {
    await publishMany(RECORDS_PER_FILE);
    const sealedId = (await manifest()).records[0].id;
    const sealed = await chunk(sealedId);

    await publishRecord(env(), record("eleventh"));

    expect(await chunk(sealedId)).toEqual(sealed);
    expect((await manifest()).records[0].id).toBe(sealedId);
  });
});

describe("concurrent publication", () => {
  it("retries against the manifest as it now stands", async () => {
    // Simulates another publication landing between our read and our write.
    let intercepted = false;
    content.interceptPut(MANIFEST_KEY, async () => {
      intercepted = true;
      await publishRecord(env(), record("theirs"));
    });

    const result = await publishRecord(env(), record("ours"));

    expect(intercepted).toBe(true);
    expect(result.status).toBe("published");

    const m = await manifest();
    // Both survive: the loser rebuilt on top of the winner rather than
    // overwriting it.
    const titles = (await chunk(m.latest!)).map((r) => r.title);
    expect(titles).toContain("theirs");
    expect(titles).toContain("ours");
    expect(m.totalRecords).toBe(2);
  });

  it("gives up rather than spinning when the manifest never settles", async () => {
    const original = content.bucket.put.bind(content.bucket);
    content.bucket.put = (async (key: string, value: string, options?: R2PutOptions) => {
      // Every conditional manifest write loses, forever.
      if (key === MANIFEST_KEY && (options?.onlyIf as R2Conditional)?.etagMatches) return null;
      return original(key, value, options);
    }) as typeof original;

    const result = await publishRecord(env(), record("ours"));

    expect(result).toEqual({ status: "failed", reason: "conflict" });
    expect((await manifest()).totalRecords).toBe(0);
  });

  it("publishes nothing when the chunk write fails", async () => {
    content.failNextPut();
    const result = await publishRecord(env(), record("ours"));

    expect(result).toEqual({ status: "failed", reason: "storage" });
    expect((await manifest()).totalRecords).toBe(0);
  });
});
