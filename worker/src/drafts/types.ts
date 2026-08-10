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

/**
 * An original file as it arrived from Telegram, stored in the private bucket.
 *
 * `mediaId` is minted by the Worker, never taken from Telegram: it names the R2
 * object and later the public derivatives, and spec §8 keeps every object name
 * under deterministic control. `fileId` is kept because Telegram can re-send a
 * file by reference, which makes a preview far cheaper than reading the
 * original back out of R2.
 */
export interface DraftOriginal {
  mediaId: string;
  type: "image" | "video";
  fileId: string;
  key: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/**
 * One sanitised item as the media pipeline reported it (spec §13.2).
 *
 * Held on the draft only when the author still has to look at it: a video the
 * transcode changed visibly is shown before it is published, and publishing it
 * afterwards has to use these exact URLs rather than ask for the work again.
 */
export interface ProcessedMedia {
  sourceId: string;
  type: "image" | "video";
  src: string;
  thumbnail?: string;
  poster?: string;
  /**
   * What the transcode changed that the author would see, in words meant for
   * them. Empty for a picture and for a clip that came through as it was —
   * a non-empty list on any item is the whole of the confirmation gate.
   */
  visibleChanges: string[];
}

export interface Draft {
  schemaVersion: number;
  draftId: string;
  state: DraftState;
  createdAt: string;
  updatedAt: string;
  source: DraftSource;
  /**
   * Names the media for this draft, in R2 and later in the public URLs. Separate
   * from draftId because a draft is private and an activity's media is not: one
   * identifier spanning both would leak the private object's name.
   */
  activityId: string;
  /**
   * Set while an album is still arriving. Telegram delivers each item as its
   * own update, so this is what lets the second and third photo find the draft
   * the first one created.
   */
  mediaGroupId: string | null;
  /** Originals in the private bucket. Empty for a text-only draft. */
  originals: DraftOriginal[];
  /**
   * Whether a file arrived for this draft and was refused.
   *
   * Kept because it changes what approving the draft means. With no surviving
   * originals, publishing posts the words alone — which is worth offering, and
   * the preview has to say so: without this the author sees the same five
   * sections a note without any attachment produces, and the first time that
   * happened a record went live describing a video it does not contain.
   *
   * Set per refused file rather than per message, so one bad photo in an album
   * records it while its siblings still publish normally.
   */
  mediaDeclined: boolean;
  /** Exactly what arrived from Telegram, kept so an edit can start over from it. */
  input: { text: string };
  /** Null until Workers AI proposes one, which is why a quota failure can leave a usable draft. */
  record: DraftRecord | null;
  /**
   * The preview currently awaiting a decision, if there is one.
   *
   * `token` is minted fresh for every preview sent, so the buttons under an
   * older preview stop working the moment a newer one replaces them — a
   * regenerated draft must not be publishable from the superseded message.
   * `messageId` is what lets those buttons be stripped once one is used.
   */
  preview: { messageId: number; token: string } | null;
  /**
   * Set once the record is live. Kept so a repeated Publish can hand back the
   * link it already produced instead of publishing a second copy — chunks are
   * immutable, so a duplicate cannot simply be edited out afterwards.
   */
  published: { recordId: string; url: string } | null;
  /**
   * Set while GitHub Actions is sanitising this draft's media. The token is the
   * only thing tying a callback back to the job that was dispatched, so a
   * replayed or forged one can be refused without trusting the draft id alone.
   */
  job: { jobToken: string; dispatchedAt: string } | null;
  /**
   * What the pipeline produced, held between the callback and the author's
   * final look at it.
   *
   * Only ever set when the transcode changed something visible, and it is what
   * tells the second pass through `awaiting_approval` from the first: a draft
   * with originals and no `processed` still has to be sanitised, one with
   * `processed` is waiting to be published from these very URLs.
   *
   * Absent rather than null on drafts written before this existed, which is why
   * every read of it goes through `?? null` — those are still inside their
   * seven-day lifecycle.
   */
  processed: { media: ProcessedMedia[]; at: string } | null;
}

export const DRAFT_SCHEMA_VERSION = 1;
