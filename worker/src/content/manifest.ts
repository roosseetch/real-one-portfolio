/**
 * The manifest: the one mutable object in the public content bucket (spec §9.2).
 *
 * It stores chunk ids and nothing else — never full filenames, which code
 * derives — so the site can fetch it once and work out every URL it needs.
 * Because it is the only mutable object, it is also the only place two
 * publications can collide, which is what the conditional write below is for.
 */

export const MANIFEST_KEY = "content/manifest.json";
export const MANIFEST_SCHEMA_VERSION = 1;

/** Spec §9.4. A chunk is sealed at ten records and a new one starts. */
export const RECORDS_PER_FILE = 10;

/**
 * Spec §9.6. The manifest changes on every publication, so it must never be
 * served from cache without checking — a stale manifest hides new records and
 *, worse, can point at a chunk that has been superseded.
 */
export const MANIFEST_CACHE_CONTROL = "no-cache";

export interface ManifestEntry {
  id: string;
  sha256: string;
  count: number;
}

export interface Manifest {
  schemaVersion: number;
  updatedAt: string;
  recordsPerFile: number;
  totalRecords: number;
  records: ManifestEntry[];
  /** Null only before anything has been published. */
  latest: string | null;
}

export function emptyManifest(now: Date = new Date()): Manifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    recordsPerFile: RECORDS_PER_FILE,
    totalRecords: 0,
    records: [],
    latest: null,
  };
}

export interface LoadedManifest {
  manifest: Manifest;
  /** Carried back into the write, so a manifest that changed meanwhile is not overwritten. */
  etag: string;
}

export async function readManifest(bucket: R2Bucket): Promise<LoadedManifest | null> {
  const object = await bucket.get(MANIFEST_KEY);
  if (object === null) return null;

  let parsed: unknown;
  try {
    parsed = await object.json();
  } catch {
    return null;
  }

  const manifest = parseManifest(parsed);
  return manifest === null ? null : { manifest, etag: object.etag };
}

function parseManifest(data: unknown): Manifest | null {
  if (typeof data !== "object" || data === null) return null;

  const manifest = data as Manifest;
  if (!Array.isArray(manifest.records)) return null;
  if (typeof manifest.schemaVersion !== "number") return null;

  // A manifest written by a newer version could mean chunks in a layout this
  // code would corrupt by appending to. Refusing is better than guessing.
  if (manifest.schemaVersion > MANIFEST_SCHEMA_VERSION) return null;

  return manifest;
}

/**
 * Writes the manifest only if it still matches what was read.
 *
 * Returns false when it has changed underneath, which is the caller's signal to
 * re-read and rebuild rather than clobber a record someone else just added.
 * R2 has no locking, so this conditional write is the whole concurrency story.
 */
export async function writeManifest(
  bucket: R2Bucket,
  manifest: Manifest,
  etag: string,
): Promise<boolean> {
  const written = await bucket.put(MANIFEST_KEY, JSON.stringify(manifest, null, 2), {
    onlyIf: { etagMatches: etag },
    httpMetadata: { contentType: "application/json", cacheControl: MANIFEST_CACHE_CONTROL },
  });

  // R2 returns null when the precondition fails rather than throwing.
  return written !== null;
}

/** Creates the manifest only if nothing is there, so bootstrapping twice cannot erase history. */
export async function createManifest(bucket: R2Bucket, manifest: Manifest): Promise<boolean> {
  const written = await bucket.put(MANIFEST_KEY, JSON.stringify(manifest, null, 2), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json", cacheControl: MANIFEST_CACHE_CONTROL },
  });

  return written !== null;
}
