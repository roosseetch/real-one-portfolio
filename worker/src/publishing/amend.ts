/**
 * Changing one record that is already published, and taking one off the site.
 *
 * Until now nothing in the Worker could: a chunk is immutable and a published
 * record was final, and the one thing that ever edited published content was
 * `scripts/unpublish-record.ts`, run by hand from a laptop. Adding a photo to an
 * activity, taking one off it, and deleting the activity outright are what the
 * author does from the chat that has to reach back into something already live.
 *
 * Immutability is not weakened to allow it. The chunk holding the record is
 * republished under a *new* id with the record replaced or dropped, and the
 * manifest entry is repointed at it — which is exactly what publishing already
 * does when it appends to a chunk that is not full. The superseded chunk is left
 * in place, unreferenced, so every URL a browser has cached stays valid for as
 * long as it is cached.
 *
 * The manifest is written last, for the reason publish.ts writes it last: a
 * chunk nothing points at is invisible, while a manifest pointing at a chunk
 * that does not exist yet is a broken site.
 */
import { newChunkId, readChunk, writeChunk } from "../content/chunks";
import {
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { isValidId } from "../ids";

/**
 * R2 offers no locking, so a losing conditional write is re-read and rebuilt
 * rather than forced. The same five attempts publication allows, for the same
 * reason: far past what one author pressing buttons can collide with, and a cap
 * so a genuinely stuck manifest fails loudly instead of spinning.
 */
const MAX_ATTEMPTS = 5;

export interface AmendEnv {
  CONTENT_BUCKET: R2Bucket;
}

export type AmendResult =
  | { status: "amended"; record: PublicRecord; chunkId: string }
  /** The record that was taken off the site, and how many are left after it. */
  | { status: "removed"; record: PublicRecord; remaining: number }
  | { status: "unchanged"; record: PublicRecord }
  | { status: "failed"; reason: "no-manifest" | "not-found" | "conflict" | "storage" };

/**
 * What to do with the record, given the version that is actually live.
 *
 * A function rather than a finished record because of the retry loop: a
 * conflicting write means someone else changed the manifest, so the record is
 * read again and the change applied to that copy rather than to the stale one
 * the caller was holding. Returning the record it was given means "nothing to
 * do", which is what makes a repeated button press harmless; returning null
 * means the record leaves the site altogether.
 */
export type Amendment = (record: PublicRecord) => PublicRecord | null;

/**
 * Applies one change to one published record.
 *
 * Every chunk is read, newest first, until the record turns up. That is the
 * whole archive in the worst case — but the alternative is an index of which
 * chunk holds which record, which would be a second mutable object in a bucket
 * that deliberately has exactly one, and it would have to stay correct across
 * every rewrite this function performs.
 */
export async function amendRecord(
  env: AmendEnv,
  recordId: string,
  amendment: Amendment,
): Promise<AmendResult> {
  // Pasted into nothing, but a caller that reached here with a malformed id is
  // asking a question with no answer, and "not found" is that answer.
  if (!isValidId(recordId)) return { status: "failed", reason: "not-found" };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const loaded = await readManifest(env.CONTENT_BUCKET);
    if (loaded === null) {
      console.error("No manifest in the content bucket; nothing could be amended");
      return { status: "failed", reason: "no-manifest" };
    }

    const { manifest, etag } = loaded;
    const found = await locate(env, manifest, recordId);
    if (found === null) return { status: "failed", reason: "not-found" };

    const original = found.records[found.position];
    const amended = amendment(original);

    // Nothing changed — a second press of a button whose work is already done.
    // Republishing an identical chunk would churn the manifest and orphan a
    // chunk for no reason.
    if (amended === original) return { status: "unchanged", record: original };

    const records =
      amended === null
        ? found.records.filter((_, index) => index !== found.position)
        : found.records.map((record, index) => (index === found.position ? amended : record));

    // Null when the chunk held only the record that has just gone: an empty
    // chunk is not written at all, its manifest entry is dropped instead.
    let chunkId: string | null = null;
    let entries: ManifestEntry[];

    if (records.length === 0) {
      entries = manifest.records.filter((entry) => entry.id !== found.chunkId);
    } else {
      chunkId = newChunkId();
      let sha256: string;
      try {
        sha256 = await writeChunk(env.CONTENT_BUCKET, chunkId, records);
      } catch {
        console.error("Could not write the amended chunk; the site is unchanged");
        return { status: "failed", reason: "storage" };
      }

      const written = { id: chunkId, sha256, count: records.length };
      entries = manifest.records.map((entry) => (entry.id === found.chunkId ? written : entry));
    }

    const updated: Manifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
      // Recomputed rather than carried over: an amendment leaves it exactly
      // where it was, and a removal must not leave the site claiming a record
      // that no longer exists.
      totalRecords: entries.reduce((sum, entry) => sum + entry.count, 0),
      records: entries,
      // Repointed only when the chunk that was rewritten is the one `latest`
      // names. Repointing it otherwise would tell the next publication to append
      // to an older chunk, which is how records start arriving out of order.
      // When that chunk is gone entirely, the newest one left takes over — and
      // nothing takes over when nothing is left.
      latest:
        manifest.latest === found.chunkId
          ? (chunkId ?? entries.at(-1)?.id ?? null)
          : manifest.latest,
    };

    if (await writeManifest(env.CONTENT_BUCKET, updated, etag)) {
      return amended === null
        ? { status: "removed", record: original, remaining: updated.totalRecords }
        : { status: "amended", record: amended, chunkId: chunkId as string };
    }

    // Something else wrote the manifest between the read and the write — a
    // publication, or another amendment. The chunk just written is orphaned,
    // and the whole thing is rebuilt against the manifest as it now stands.
    console.warn(`Manifest changed during an amendment; retrying (attempt ${attempt})`);
  }

  console.error("Gave up amending a record after repeated manifest conflicts");
  return { status: "failed", reason: "conflict" };
}

/**
 * Takes a record off the site altogether.
 *
 * The same rewrite as any other amendment, and deliberately so: whether a record
 * is edited or dropped, the chunk holding it is republished under a new id and
 * the old one is left where it was. Only the arithmetic differs, and it lives
 * above rather than in a second copy of the manifest's conditional-write loop.
 *
 * Nothing here touches the media bucket. The record is what a visitor reads, so
 * it stops naming the files first; deleting them is the caller's next step.
 */
export function retractRecord(env: AmendEnv, recordId: string): Promise<AmendResult> {
  return amendRecord(env, recordId, () => null);
}

interface Located {
  chunkId: string;
  records: PublicRecord[];
  position: number;
}

/** The chunk holding a record, searched newest first because that is where a recent one is. */
async function locate(
  env: AmendEnv,
  manifest: Manifest,
  recordId: string,
): Promise<Located | null> {
  for (let i = manifest.records.length - 1; i >= 0; i--) {
    const chunkId = manifest.records[i].id;
    const records = await readChunk(env.CONTENT_BUCKET, chunkId);
    const position = records.findIndex((record) => record.id === recordId);
    if (position !== -1) return { chunkId, records, position };
  }

  return null;
}
