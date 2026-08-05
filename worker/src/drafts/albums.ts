/**
 * Ties the items of a Telegram album to one draft.
 *
 * Sending three photos at once produces three separate webhook updates, seconds
 * apart, each carrying the same `media_group_id` and no other link. Without
 * this pointer each one would start its own draft and the author would get
 * three previews for one moment.
 *
 * Stored under drafts/ so the bucket's seven-day rule collects it, and given a
 * much shorter deadline of its own: an album arrives within seconds, so a
 * pointer older than that belongs to something already finished.
 */

const TTL_MS = 5 * 60 * 1000;

interface AlbumPointer {
  draftId: string;
  expiresAt: string;
}

/** Telegram's group ids are digits, but they arrive from the network, so this is checked before it becomes a path. */
function isValidGroupId(mediaGroupId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(mediaGroupId);
}

function albumKey(mediaGroupId: string): string {
  return `drafts/albums/${mediaGroupId}.json`;
}

export async function rememberAlbum(
  bucket: R2Bucket,
  mediaGroupId: string,
  draftId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!isValidGroupId(mediaGroupId)) return;

  const pointer: AlbumPointer = { draftId, expiresAt: new Date(now.getTime() + TTL_MS).toISOString() };
  await bucket.put(albumKey(mediaGroupId), JSON.stringify(pointer), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * The draft this album already belongs to, if any.
 *
 * Unlike a pending edit this is read without clearing: every remaining item of
 * the album still has to find it.
 */
export async function findAlbumDraft(
  bucket: R2Bucket,
  mediaGroupId: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!isValidGroupId(mediaGroupId)) return null;

  const object = await bucket.get(albumKey(mediaGroupId));
  if (object === null) return null;

  let pointer: AlbumPointer;
  try {
    pointer = (await object.json()) as AlbumPointer;
  } catch {
    return null;
  }

  if (typeof pointer?.draftId !== "string" || typeof pointer.expiresAt !== "string") return null;
  if (Date.parse(pointer.expiresAt) <= now.getTime()) return null;

  return pointer.draftId;
}
