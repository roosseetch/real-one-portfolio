/**
 * Changing one record that is already published.
 *
 * Until now nothing in the Worker could: a chunk is immutable and a published
 * record was final, and the one thing that ever edited published content was
 * `scripts/unpublish-record.ts`, run by hand from a laptop. Adding a photo to an
 * activity, or taking one off it, is the first thing the author does from the
 * chat that has to reach back into something already live.
 *
 * Immutability is not weakened to allow it. The chunk holding the record is
 * republished under a *new* id with the record replaced, and the manifest entry
 * is repointed at it — which is exactly what publishing already does when it
 * appends to a chunk that is not full. The superseded chunk is left in place,
 * unreferenced, so every URL a browser has cached stays valid for as long as it
 * is cached.
 *
 * The manifest is written last, for the reason publish.ts writes it last: a
 * chunk nothing points at is invisible, while a manifest pointing at a chunk
 * that does not exist yet is a broken site.
 */
import { newChunkId, readChunk, writeChunk } from "../content/chunks";
import { readManifest, writeManifest, type Manifest } from "../content/manifest";
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
  | { status: "unchanged"; record: PublicRecord }
  | { status: "failed"; reason: "no-manifest" | "not-found" | "conflict" | "storage" };

/**
 * What to do with the record, given the version that is actually live.
 *
 * A function rather than a finished record because of the retry loop: a
 * conflicting write means someone else changed the manifest, so the record is
 * read again and the change applied to that copy rather than to the stale one
 * the caller was holding. Returning the record it was given means "nothing to
 * do", which is what makes a repeated button press harmless.
 */
export type Amendment = (record: PublicRecord) => PublicRecord;

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

    const amended = amendment(found.records[found.position]);

    // Nothing changed — a second press of a button whose work is already done.
    // Republishing an identical chunk would churn the manifest and orphan a
    // chunk for no reason.
    if (amended === found.records[found.position]) {
      return { status: "unchanged", record: amended };
    }

    const records = found.records.map((record, index) => (index === found.position ? amended : record));

    const chunkId = newChunkId();
    let sha256: string;
    try {
      sha256 = await writeChunk(env.CONTENT_BUCKET, chunkId, records);
    } catch {
      console.error("Could not write the amended chunk; the site is unchanged");
      return { status: "failed", reason: "storage" };
    }

    const updated: Manifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
      records: manifest.records.map((entry) =>
        entry.id === found.chunkId ? { id: chunkId, sha256, count: records.length } : entry,
      ),
      // Only when the chunk that was rewritten is the one `latest` names.
      // Repointing it otherwise would tell the next publication to append to an
      // older chunk, which is how records start arriving out of order.
      latest: manifest.latest === found.chunkId ? chunkId : manifest.latest,
    };

    if (await writeManifest(env.CONTENT_BUCKET, updated, etag)) {
      return { status: "amended", record: amended, chunkId };
    }

    // Something else wrote the manifest between the read and the write — a
    // publication, or another amendment. The chunk just written is orphaned,
    // and the whole thing is rebuilt against the manifest as it now stands.
    console.warn(`Manifest changed during an amendment; retrying (attempt ${attempt})`);
  }

  console.error("Gave up amending a record after repeated manifest conflicts");
  return { status: "failed", reason: "conflict" };
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
