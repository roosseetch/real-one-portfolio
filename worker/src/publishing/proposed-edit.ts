/**
 * A change the author has typed and not yet saved.
 *
 * It exists because the preview and the press that accepts it are two separate
 * Telegram updates, and callback_data has 64 bytes — enough for an id, nowhere
 * near enough for a paragraph. So the words wait here and the button carries
 * only the name of where they are.
 *
 * Keyed by its own id rather than by chat, which is what makes a stale button
 * safe. Two edits started in a row would otherwise share one key, and pressing
 * Save on the older message would apply the *newer* change — the author reading
 * one screenful of text and saving a different one. Keyed this way, each button
 * does exactly what the message it sits under says, which is the same rule the
 * remove-media buttons follow and the reason neither flow carries a token.
 *
 * A proposal is consumed by the press that saves it, so a second press of the
 * same button finds nothing rather than writing twice. An earlier proposal that
 * was never saved stays usable until it expires — pressing it puts back the
 * wording its own message showed, which is recoverable and is what the button
 * says it does.
 *
 * Stored under drafts/ so the bucket's seven-day rule sweeps up anything
 * abandoned, and given a shorter deadline of its own besides.
 */
import { isValidId, randomId } from "../ids";
import type { EditableField } from "./edit-fields";
import type { FieldValue } from "./edit-fields";

/**
 * Long enough to put the phone down and come back to it, short enough that a
 * proposal found tomorrow is not saved against a record that has moved on.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

const ID_LENGTH = 12;

export interface ProposedEdit {
  editId: string;
  /** Which published record this changes. */
  recordId: string;
  field: EditableField;
  /**
   * The new value, and only the new value — never the whole record.
   *
   * The change is applied to whatever is live at the moment Save is pressed, so
   * a photo added to the activity in between survives it. Storing a finished
   * record here would quietly undo anything that landed after the preview.
   */
  value: FieldValue;
  expiresAt: string;
}

function editKey(editId: string): string {
  return `drafts/edits/${editId}.json`;
}

export function newEditId(): string {
  return randomId(ID_LENGTH);
}

export async function saveProposedEdit(
  bucket: R2Bucket,
  proposal: Omit<ProposedEdit, "expiresAt">,
  now: Date = new Date(),
): Promise<void> {
  const stored: ProposedEdit = {
    ...proposal,
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };

  await bucket.put(editKey(proposal.editId), JSON.stringify(stored), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Reads a proposal and clears it in one go.
 *
 * Cleared even when it has expired: leaving a dead one in place would have every
 * later press of the same button check, and fail, the same stale object.
 */
export async function takeProposedEdit(
  bucket: R2Bucket,
  editId: string,
  now: Date = new Date(),
): Promise<ProposedEdit | null> {
  // Pasted straight into an object key, and arriving from a callback: an id with
  // a slash in it would name something outside drafts/edits/ altogether.
  if (!isValidId(editId)) return null;

  const key = editKey(editId);
  const object = await bucket.get(key);
  if (object === null) return null;

  await bucket.delete(key);

  let stored: ProposedEdit;
  try {
    stored = (await object.json()) as ProposedEdit;
  } catch {
    return null;
  }

  if (typeof stored?.expiresAt !== "string") return null;
  if (Date.parse(stored.expiresAt) <= now.getTime()) return null;
  if (typeof stored.recordId !== "string" || typeof stored.field !== "string") return null;

  return stored;
}
