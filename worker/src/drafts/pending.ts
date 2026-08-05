/**
 * Remembers that a chat owes an edit instruction (spec §7.3, step 2).
 *
 * Pressing "Edit text" and then typing the change are two separate Telegram
 * updates, and the second one looks exactly like someone starting a new draft.
 * This pointer is what tells them apart. It is keyed by chat rather than by
 * message, because the author replies with an ordinary message rather than a
 * threaded reply.
 *
 * Stored under drafts/ so the bucket's seven-day rule sweeps up anything left
 * behind, and given a much shorter deadline of its own besides.
 */

/**
 * A forgotten prompt should not silently swallow tomorrow's note as an edit
 * instruction, so the pointer stops applying long before the draft expires.
 */
const TTL_MS = 30 * 60 * 1000;

interface PendingEdit {
  draftId: string;
  expiresAt: string;
}

function pendingKey(chatId: number): string {
  return `drafts/pending/${chatId}.json`;
}

/** Chat ids arrive from Telegram, so they are checked before they become a path. */
function isValidChatId(chatId: number): boolean {
  return Number.isSafeInteger(chatId);
}

export async function setPendingEdit(
  bucket: R2Bucket,
  chatId: number,
  draftId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!isValidChatId(chatId)) return;

  const pending: PendingEdit = {
    draftId,
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };

  await bucket.put(pendingKey(chatId), JSON.stringify(pending), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Reads and clears the pointer in one go.
 *
 * Clearing even when the pointer has expired matters: leaving a dead one in
 * place would have every later message check, and fail, the same stale record.
 */
export async function takePendingEdit(
  bucket: R2Bucket,
  chatId: number,
  now: Date = new Date(),
): Promise<string | null> {
  if (!isValidChatId(chatId)) return null;

  const key = pendingKey(chatId);
  const object = await bucket.get(key);
  if (object === null) return null;

  await bucket.delete(key);

  let pending: PendingEdit;
  try {
    pending = (await object.json()) as PendingEdit;
  } catch {
    return null;
  }

  if (typeof pending?.draftId !== "string" || typeof pending.expiresAt !== "string") return null;
  if (Date.parse(pending.expiresAt) <= now.getTime()) return null;

  return pending.draftId;
}

export async function clearPendingEdit(bucket: R2Bucket, chatId: number): Promise<void> {
  if (!isValidChatId(chatId)) return;
  await bucket.delete(pendingKey(chatId));
}
