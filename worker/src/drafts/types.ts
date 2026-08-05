/**
 * The draft as it is stored in private R2 at `drafts/{draft-id}/draft.json`
 * (spec §7.4). Nothing here is ever served publicly: the draft holds the raw
 * Telegram input and the chat it came from, alongside the record proposed for
 * publication.
 */

/** Spec §22. `published` and `cancelled` are terminal. */
export type DraftState =
  | "draft"
  | "awaiting_approval"
  | "processing"
  | "published"
  | "failed"
  | "cancelled";

/**
 * A media item as Workers AI proposes it (spec §8): the model names the
 * alt text and caption, never the URL. Real URLs only exist after the media
 * pipeline has sanitized the file, and are filled in at publication.
 */
export interface DraftMedia {
  mediaId: string;
  alt: string | null;
  caption: string | null;
}

/**
 * The record proposed for publication, in the shape spec §8 requires from the
 * model. Task 16 owns validating that a model response really matches this;
 * here it is only carried and stored.
 */
export interface DraftRecord {
  title: string;
  summary: string | null;
  body: string | null;
  eventDate: string | null;
  tags: string[];
  media: DraftMedia[];
}

/** Where the draft came from, so the preview can be sent back to the right chat. */
export interface DraftSource {
  chatId: number;
  senderId: number;
  messageId: number;
}

export interface Draft {
  schemaVersion: number;
  draftId: string;
  state: DraftState;
  createdAt: string;
  updatedAt: string;
  source: DraftSource;
  /** Exactly what arrived from Telegram, kept so an edit can start over from it. */
  input: { text: string };
  /** Null until Workers AI proposes one, which is why a quota failure can leave a usable draft. */
  record: DraftRecord | null;
}

export const DRAFT_SCHEMA_VERSION = 1;
