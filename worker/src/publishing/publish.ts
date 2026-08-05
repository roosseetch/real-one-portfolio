/**
 * Text-only publication (spec §9.5, §10.2).
 *
 * The order is the whole design: the chunk is written first and the manifest
 * last. A chunk nothing points at is invisible, so a failure between the two
 * leaves the site exactly as it was. The reverse order would publish a manifest
 * pointing at an object that does not exist yet.
 */
import {
  RECORDS_PER_FILE,
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from "../content/manifest";
import { newChunkId, readChunk, writeChunk } from "../content/chunks";
import type { PublicRecord } from "../content/records";

/**
 * R2 offers no locking, so a losing conditional write is re-read and rebuilt
 * rather than forced. Five attempts is far past what one author pressing
 * buttons can collide with; the cap exists so a genuinely stuck manifest fails
 * loudly instead of spinning.
 */
const MAX_ATTEMPTS = 5;

export interface PublishEnv {
  CONTENT_BUCKET: R2Bucket;
}

export type PublishResult =
  | { status: "published"; record: PublicRecord; chunkId: string }
  | { status: "failed"; reason: "no-manifest" | "conflict" | "storage" };

/**
 * Decides the next manifest, given a chunk that has just been written.
 *
 * Pure, so the chunk arithmetic that spec §9.5 specifies can be tested without
 * a bucket: whether the latest chunk is replaced or a new one is appended, and
 * what `latest` and the counts become.
 */
export function nextManifest(
  manifest: Manifest,
  entry: ManifestEntry,
  rolled: boolean,
  now: Date = new Date(),
): Manifest {
  const records = rolled
    ? // Full, or nothing published yet: the new chunk joins the list.
      [...manifest.records, entry]
    : // Not full: the superseded chunk's entry is replaced outright, which is
      // why the old chunk can be left to expire rather than deleted in-band.
      manifest.records.map((existing) => (existing.id === manifest.latest ? entry : existing));

  return {
    ...manifest,
    updatedAt: now.toISOString(),
    recordsPerFile: RECORDS_PER_FILE,
    totalRecords: records.reduce((sum, chunk) => sum + chunk.count, 0),
    records,
    latest: entry.id,
  };
}

export async function publishRecord(env: PublishEnv, record: PublicRecord): Promise<PublishResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const loaded = await readManifest(env.CONTENT_BUCKET);
    if (loaded === null) {
      // Bootstrapping is a deliberate, separate step. Creating one here would
      // mean a misconfigured bucket silently starts a second history.
      console.error("No manifest in the content bucket; run the bootstrap script first");
      return { status: "failed", reason: "no-manifest" };
    }

    const { manifest, etag } = loaded;
    const latestEntry = manifest.records.find((chunk) => chunk.id === manifest.latest) ?? null;
    const rolled = latestEntry === null || latestEntry.count >= RECORDS_PER_FILE;

    // Read before write, so an append lands on top of whatever the chunk holds
    // now rather than on top of a stale copy.
    const existing = rolled ? [] : await readChunk(env.CONTENT_BUCKET, latestEntry.id);
    const records = [...existing, record];

    const chunkId = newChunkId();
    let sha256: string;
    try {
      sha256 = await writeChunk(env.CONTENT_BUCKET, chunkId, records);
    } catch {
      console.error("Could not write the record chunk; nothing was published");
      return { status: "failed", reason: "storage" };
    }

    const updated = nextManifest(manifest, { id: chunkId, sha256, count: records.length }, rolled);

    if (await writeManifest(env.CONTENT_BUCKET, updated, etag)) {
      return { status: "published", record, chunkId };
    }

    // Someone else published between the read and the write. The chunk just
    // written is orphaned — unreferenced, so invisible — and the whole thing is
    // rebuilt against the manifest as it now stands.
    console.warn(`Manifest changed during publication; retrying (attempt ${attempt})`);
  }

  console.error("Gave up publishing after repeated manifest conflicts");
  return { status: "failed", reason: "conflict" };
}
