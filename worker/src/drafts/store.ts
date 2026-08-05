/**
 * Draft persistence in the private R2 bucket (spec §7.4).
 *
 * Only ever the private bucket. A draft holds the raw Telegram input and the
 * chat it came from, so nothing in here may reach the public buckets — the
 * published record is built separately, from the fields cleared for publication.
 *
 * The bucket's seven-day lifecycle rule on `drafts/` is what eventually removes
 * these; nothing here deletes them, so an abandoned or failed draft stays
 * recoverable until it expires.
 */
import { randomId } from "../ids";
import { DRAFT_SCHEMA_VERSION, type Draft, type DraftSource } from "./types";

export function draftKey(draftId: string): string {
  return `drafts/${draftId}/draft.json`;
}

/** Rejects anything that could climb out of the drafts/ prefix or name a different object. */
function isValidDraftId(draftId: string): boolean {
  return /^[0-9a-z]{8,64}$/.test(draftId);
}

export async function saveDraft(bucket: R2Bucket, draft: Draft): Promise<void> {
  await bucket.put(draftKey(draft.draftId), JSON.stringify(draft), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Null covers both "no such draft" and "the stored object is not a draft we can
 * read". A draft whose JSON is unreadable is indistinguishable from a missing
 * one to every caller, and both mean the same thing: there is nothing to act on.
 */
export async function loadDraft(bucket: R2Bucket, draftId: string): Promise<Draft | null> {
  if (!isValidDraftId(draftId)) return null;

  const object = await bucket.get(draftKey(draftId));
  if (object === null) return null;

  let parsed: unknown;
  try {
    parsed = await object.json();
  } catch {
    return null;
  }

  return parseDraft(parsed);
}

/**
 * Checks the fields every caller relies on to route and to decide what may
 * happen next. Deliberately shallow past that, in the same spirit as the
 * webhook's update parsing: whoever reads `record` validates it then.
 */
function parseDraft(data: unknown): Draft | null {
  if (typeof data !== "object" || data === null) return null;

  const draft = data as Draft;
  if (typeof draft.draftId !== "string" || typeof draft.state !== "string") return null;
  if (typeof draft.source !== "object" || draft.source === null) return null;
  if (typeof draft.source.chatId !== "number") return null;

  return draft;
}

/**
 * Creates and persists a new draft in state `draft`.
 *
 * The ID is generated here rather than derived from the message: spec §8 puts
 * IDs, paths, and state under deterministic Worker control, never the model's,
 * and a content-derived ID would leak the content it came from.
 */
export async function createDraft(
  bucket: R2Bucket,
  source: DraftSource,
  text: string,
  now: Date = new Date(),
  mediaGroupId: string | null = null,
): Promise<Draft> {
  const timestamp = now.toISOString();
  const draft: Draft = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    draftId: randomId(),
    state: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    source,
    // Minted here alongside the draft id and kept distinct from it: a draft is
    // private, its media becomes public, and one identifier spanning both would
    // put the private object's name into a public URL.
    activityId: randomId(),
    mediaGroupId,
    originals: [],
    input: { text },
    // Task 16 fills this in from Workers AI. It stays null if the model is
    // unavailable, which is what lets the draft survive a quota failure.
    record: null,
    // No preview has been sent, so there is no live button anywhere.
    preview: null,
    published: null,
  };

  await saveDraft(bucket, draft);
  return draft;
}
