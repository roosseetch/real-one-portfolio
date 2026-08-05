/**
 * Record chunks: immutable arrays of at most ten published records (spec §9.4,
 * §9.5).
 *
 * A chunk is never edited. Adding a record to a chunk that is not yet full
 * means writing a whole new chunk under a new id and repointing the manifest at
 * it, which is what lets the old one be cached forever without ever going
 * stale. The filename is derived here; the manifest stores only the id.
 */
import { randomId } from "../ids";
import type { PublicRecord } from "./records";

/**
 * Long enough that chunk URLs cannot be walked by hand. Spec §9.3 is explicit
 * that this reduces casual enumeration without being a security boundary —
 * published files are public by design.
 */
const CHUNK_ID_LENGTH = 12;

/** Spec §9.6: a chunk never changes, so it can be cached for as long as caches allow. */
export const CHUNK_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function chunkKey(chunkId: string): string {
  return `content/records-${chunkId}.json`;
}

export function newChunkId(): string {
  return randomId(CHUNK_ID_LENGTH);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Empty for a chunk that is missing or unreadable: a lost chunk must not block publishing. */
export async function readChunk(bucket: R2Bucket, chunkId: string): Promise<PublicRecord[]> {
  const object = await bucket.get(chunkKey(chunkId));
  if (object === null) return [];

  try {
    const parsed = await object.json();
    return Array.isArray(parsed) ? (parsed as PublicRecord[]) : [];
  } catch {
    return [];
  }
}

/** Returns the digest the manifest entry records, so the site can tell a truncated chunk from a whole one. */
export async function writeChunk(
  bucket: R2Bucket,
  chunkId: string,
  records: PublicRecord[],
): Promise<string> {
  const body = JSON.stringify(records, null, 2);

  await bucket.put(chunkKey(chunkId), body, {
    httpMetadata: { contentType: "application/json", cacheControl: CHUNK_CACHE_CONTROL },
  });

  return sha256Hex(body);
}
