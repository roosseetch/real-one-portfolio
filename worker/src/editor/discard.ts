/**
 * Discard: the author is done with a link before its four hours are.
 *
 * Three things outlive a draft nobody publishes. The key, which would go on
 * opening the editor for whoever has the link. The pictures uploaded with it,
 * whose derivatives sit in the public media bucket — unreferenced, but readable
 * by anyone with the address, and under no lifecycle rule, so for ever. And
 * their originals in the private bucket, GPS and all, until the seven-day rule.
 * Discard removes all three; the page clears the text it kept in the browser.
 *
 * A published article is not discarded with it. Whatever the record still
 * shows from this link's folder stays, so discarding after publishing ends the
 * link and drops only the pictures the article never used.
 *
 * The key goes first. Nothing can be uploaded with it after that, and a picture
 * that was mid-sanitising when it went is deleted when its callback arrives
 * (callbacks/media-processed.ts), so the folder cannot refill behind this.
 */
import { ALL_CHUNKS, findRecord, type RecentEnv } from "../content/recent";
import { deleteOriginals } from "../media/originals";
import { deletePublishedMediaExcept, locateMedia } from "../media/published";
import { revokeKey, type EditorKey, type EditorKeysEnv } from "./keys";

export interface EditorDiscardEnv extends EditorKeysEnv, RecentEnv {
  MEDIA_BUCKET: R2Bucket;
}

export type DiscardOutcome =
  | { status: "discarded"; removed: number; articleKept: boolean }
  | { status: "failed" };

export async function discardKey(env: EditorDiscardEnv, key: EditorKey, hash: string): Promise<DiscardOutcome> {
  // Read before anything is deleted: a storage hiccup here must not cost the
  // published article its pictures.
  const keep = new Set<string>();
  let articleKept = false;
  if (key.recordId !== null) {
    let record;
    try {
      record = await findRecord(env, key.recordId, ALL_CHUNKS);
    } catch {
      return { status: "failed" };
    }
    if (record !== null) {
      articleKept = true;
      for (const item of record.media ?? []) {
        for (const url of [item.src, item.thumbnail, item.poster]) {
          const location = url ? locateMedia(url) : null;
          if (location !== null && location.activityId === key.activityId) keep.add(location.mediaId);
        }
      }
    }
  }

  try {
    await revokeKey(env, hash);
  } catch {
    return { status: "failed" };
  }

  const removed = await deletePublishedMediaExcept(env.MEDIA_BUCKET, key.activityId, keep);
  // Originals are inputs only; a published picture needs none of them.
  await deleteOriginals(env.PRIVATE_BUCKET, key.activityId);

  return { status: "discarded", removed, articleKept };
}
