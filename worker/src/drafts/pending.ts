/**
 * Remembers what a chat's next message is for (spec §7.3, step 2).
 *
 * Pressing "Edit text" and then typing the change are two separate Telegram
 * updates, and the second one looks exactly like someone starting a new draft.
 * This pointer is what tells them apart. It is keyed by chat rather than by
 * message, because the author replies with an ordinary message rather than a
 * threaded reply.
 *
 * "Publish as written" works the same way and shares the pointer, because the
 * two are mutually exclusive by nature: a chat cannot owe an edit instruction
 * and a verbatim note at the same time, and asking for one after the other
 * plainly means the author changed their mind. One key makes that automatic —
 * two would leave both armed and the order of the checks deciding which wins.
 *
 * Stored under drafts/ so the bucket's seven-day rule sweeps up anything left
 * behind, and given a much shorter deadline of its own besides.
 */

/**
 * A forgotten prompt should not silently swallow tomorrow's note as an edit
 * instruction, so the pointer stops applying long before the draft expires.
 */
const TTL_MS = 30 * 60 * 1000;

/** What the chat's next message will be taken as. */
export type Pending =
  | { kind: "edit"; draftId: string }
  | { kind: "verbatim" }
  /**
   * The next thing sent is media for an activity that is already published, not
   * a new entry. Nothing else distinguishes the two: a photo sent to this bot
   * has always meant "write me an activity about this".
   */
  | { kind: "attach" }
  /** The next message names the activity these already-filed files belong to. */
  | { kind: "attach-target"; draftId: string }
  /** The next message names the activity to take media off. */
  | { kind: "detach-target" };

interface StoredPending {
  kind?: Pending["kind"];
  draftId?: string;
  expiresAt: string;
}

function pendingKey(chatId: number): string {
  return `drafts/pending/${chatId}.json`;
}

/** Chat ids arrive from Telegram, so they are checked before they become a path. */
function isValidChatId(chatId: number): boolean {
  return Number.isSafeInteger(chatId);
}

async function setPending(
  bucket: R2Bucket,
  chatId: number,
  pending: Pending,
  now: Date,
): Promise<void> {
  if (!isValidChatId(chatId)) return;

  const stored: StoredPending = {
    ...pending,
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };

  await bucket.put(pendingKey(chatId), JSON.stringify(stored), {
    httpMetadata: { contentType: "application/json" },
  });
}

export function setPendingEdit(
  bucket: R2Bucket,
  chatId: number,
  draftId: string,
  now: Date = new Date(),
): Promise<void> {
  return setPending(bucket, chatId, { kind: "edit", draftId }, now);
}

export function setPendingVerbatim(
  bucket: R2Bucket,
  chatId: number,
  now: Date = new Date(),
): Promise<void> {
  return setPending(bucket, chatId, { kind: "verbatim" }, now);
}

export function setPendingAttach(
  bucket: R2Bucket,
  chatId: number,
  now: Date = new Date(),
): Promise<void> {
  return setPending(bucket, chatId, { kind: "attach" }, now);
}

export function setPendingAttachTarget(
  bucket: R2Bucket,
  chatId: number,
  draftId: string,
  now: Date = new Date(),
): Promise<void> {
  return setPending(bucket, chatId, { kind: "attach-target", draftId }, now);
}

export function setPendingDetachTarget(
  bucket: R2Bucket,
  chatId: number,
  now: Date = new Date(),
): Promise<void> {
  return setPending(bucket, chatId, { kind: "detach-target" }, now);
}

/**
 * Consumes an "attach" pointer, and only that one.
 *
 * The media path needs to know whether these files are for an existing activity
 * *before* it files them, and it cannot use `takePending`: an album arrives as
 * several updates, and clearing an edit or verbatim pointer on the way past
 * would silently swallow what the author was actually promised. So this reads
 * the pointer, leaves anything else exactly where it was, and clears only its
 * own kind.
 */
export async function takePendingAttach(
  bucket: R2Bucket,
  chatId: number,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isValidChatId(chatId)) return false;

  const object = await bucket.get(pendingKey(chatId));
  if (object === null) return false;

  let stored: StoredPending;
  try {
    stored = (await object.json()) as StoredPending;
  } catch {
    return false;
  }

  if (stored?.kind !== "attach") return false;
  if (typeof stored.expiresAt !== "string" || Date.parse(stored.expiresAt) <= now.getTime()) {
    // Expired, and still ours to clear: leaving it would have the next album
    // item read the same dead pointer.
    await bucket.delete(pendingKey(chatId));
    return false;
  }

  await bucket.delete(pendingKey(chatId));
  return true;
}

/**
 * Reads and clears the pointer in one go.
 *
 * Clearing even when the pointer has expired matters: leaving a dead one in
 * place would have every later message check, and fail, the same stale record.
 */
export async function takePending(
  bucket: R2Bucket,
  chatId: number,
  now: Date = new Date(),
): Promise<Pending | null> {
  if (!isValidChatId(chatId)) return null;

  const key = pendingKey(chatId);
  const object = await bucket.get(key);
  if (object === null) return null;

  await bucket.delete(key);

  let stored: StoredPending;
  try {
    stored = (await object.json()) as StoredPending;
  } catch {
    return null;
  }

  if (typeof stored?.expiresAt !== "string") return null;
  if (Date.parse(stored.expiresAt) <= now.getTime()) return null;

  if (stored.kind === "verbatim") return { kind: "verbatim" };
  if (stored.kind === "attach") return { kind: "attach" };
  if (stored.kind === "detach-target") return { kind: "detach-target" };
  if (stored.kind === "attach-target") {
    return typeof stored.draftId === "string" ? { kind: "attach-target", draftId: stored.draftId } : null;
  }

  // An absent `kind` is an edit pointer written before this field existed. They
  // live half an hour at most, so this only matters across a deploy — but it is
  // one comparison, and the alternative is swallowing the author's next message.
  if (typeof stored.draftId === "string") return { kind: "edit", draftId: stored.draftId };

  return null;
}

export async function clearPending(bucket: R2Bucket, chatId: number): Promise<void> {
  if (!isValidChatId(chatId)) return;
  await bucket.delete(pendingKey(chatId));
}
