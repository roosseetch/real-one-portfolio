/**
 * Removing derivatives the site no longer points at.
 *
 * Two things reach here. The media pipeline uploads to the public bucket before
 * it calls back, so a video the author declines at the confirmation step has
 * already been written there: nothing links to it — no record, no manifest
 * entry — but "unreachable" is not the same as "gone", and the author declined
 * it. And an item taken off a published activity is the same situation arrived
 * at from the other end: the record has stopped naming it, and leaving the file
 * readable would make "remove" mean "hide".
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
 * Everything the pipeline produced from one source file.
 *
 * The sanitiser names every derivative `{mediaId}-{width}.webp`,
 * `{mediaId}-poster-{width}.webp` or `{mediaId}-{width}.mp4`, and the media id
 * is Crockford base32 — no hyphen can appear in it. So the id followed by a
 * hyphen is a prefix that matches this item's whole set and nothing else's,
 * which is what lets one picture be removed from an activity without disturbing
 * the ones beside it.
 */
export function mediaItemPrefix(activityId: string, mediaId: string): string {
  return `${activityPrefix(activityId)}${mediaId}-`;
}

/** Which activity's media a public URL names, and which item of it. */
export interface MediaLocation {
  activityId: string;
  mediaId: string;
}

/**
 * Reads an activity id and a media id back out of a published URL.
 *
 * The record stores URLs and nothing else — it always has — so this is the only
 * way to get from "the author pointed at this picture" to the objects behind
 * it. Both halves are checked against `isValidId` before they are returned,
 * because the caller pastes them into an object prefix: a URL naming
 * `activity-../` or an id with a slash in it would otherwise reach past the
 * activity it claims to be.
 *
 * Null for anything that is not one of ours, which includes a URL from a media
 * bucket that is not this deployment's — the caller checks the host separately,
 * and this checks the shape.
 */
export function locateMedia(url: string): MediaLocation | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  const match = /\/media\/activity-([^/]+)\/([^/-]+)-[^/]+$/.exec(path);
  if (match === null) return null;

  const [, activityId, mediaId] = match;
  if (!isValidId(activityId) || !isValidId(mediaId)) return null;

  return { activityId, mediaId };
}

/**
 * Deletes every derivative of one media item.
 *
 * Shaped like the whole-activity delete below and for the same reasons: never
 * throws, and returns how many objects went. A count of zero is not an error —
 * a repeated press of Remove finds the set already gone.
 */
export async function deletePublishedItem(
  bucket: R2Bucket,
  location: MediaLocation,
): Promise<number> {
  if (!isValidId(location.activityId) || !isValidId(location.mediaId)) {
    console.error("Refused to delete media for ids that are not ours");
    return 0;
  }

  return deleteUnder(bucket, mediaItemPrefix(location.activityId, location.mediaId));
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

  return deleteUnder(bucket, activityPrefix(activityId));
}

/**
 * Empties one prefix, page by page.
 *
 * Split out because both callers want exactly this and neither wants it to
 * throw. The prefix is built by the callers above, which have already checked
 * every id that goes into it.
 */
async function deleteUnder(bucket: R2Bucket, prefix: string): Promise<number> {
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
