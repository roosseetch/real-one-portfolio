/**
 * Removing derivatives that were uploaded and then not published.
 *
 * The media pipeline uploads to the public bucket before it calls back, so a
 * video the author declines at the confirmation step has already been written
 * there. Nothing links to it — no record, no manifest entry — but "unreachable"
 * is not the same as "gone", and the author declined it.
 *
 * This is the only thing in the Worker that touches the media bucket, and it
 * only ever deletes. Media is written by GitHub Actions, after sanitisation, and
 * that has not changed.
 */
import { isValidId } from "../ids";

/** R2 lists in pages; the default is 1000 keys, which is far past any one activity. */
const PAGE_LIMIT = 1000;

/**
 * A stop, not a limit anyone should reach: an activity's whole set is a handful
 * of files times four widths times two formats. It exists because the loop below
 * re-lists rather than pages, so a delete that silently did nothing would
 * otherwise spin for ever.
 */
const MAX_PAGES = 10;

export function activityPrefix(activityId: string): string {
  return `media/activity-${activityId}/`;
}

/**
 * Deletes everything under one activity's prefix.
 *
 * Never throws: this runs while cancelling a draft, and a cancellation that
 * fails because a delete did would leave the author with a live preview for
 * something they have already declined. Returns how many objects went.
 */
export async function deletePublishedMedia(bucket: R2Bucket, activityId: string): Promise<number> {
  // The id is minted by the Worker and never taken from an author or a
  // callback, so this can only fail on a draft written by something else — but
  // it is pasted straight into an object prefix, and a prefix with a slash in it
  // names a different activity's media.
  if (!isValidId(activityId)) {
    console.error("Refused to delete media for an activity id that is not one of ours");
    return 0;
  }

  const prefix = activityPrefix(activityId);
  let removed = 0;

  try {
    // Re-listed each time rather than followed by cursor: every key listed is
    // then deleted, so the next list starts from whatever is left. Carrying a
    // cursor through a collection this loop is emptying is the fragile way of
    // doing the same thing.
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await bucket.list({ prefix, limit: PAGE_LIMIT });
      const keys = listed.objects.map((object) => object.key);
      if (keys.length === 0) return removed;

      await bucket.delete(keys);
      removed += keys.length;
    }

    console.error(`Stopped after ${MAX_PAGES} pages with media still under the prefix`);
  } catch {
    // Counted rather than re-thrown. What is left behind is unreferenced and
    // invisible; what matters is that the cancellation itself completes.
    console.error(`Could not remove every processed file; ${removed} of them went`);
  }

  return removed;
}
