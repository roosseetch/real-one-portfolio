/**
 * The published record — the only shape the website ever reads.
 *
 * Everything private stays behind: the raw Telegram text, the chat it came
 * from, the draft id, the state. Spec §24 requires public JSON to contain only
 * publishable fields, and the way to guarantee that is to build the public
 * record explicitly rather than to strip fields off the draft.
 */
import { randomId } from "../ids";
import type { DraftRecord } from "../drafts/types";

export interface PublicMedia {
  type: "image" | "video";
  src: string;
  thumbnail?: string;
  poster?: string;
  alt: string | null;
  caption: string | null;
}

export interface PublicRecord {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  /** What the author's note said happened, when it said anything. Often null. */
  eventDate: string | null;
  /**
   * When this record went live, stamped here rather than anywhere else.
   *
   * The site orders the feed on it. `eventDate` cannot do that job: the model
   * fills it in only when the note names a date, so most records carry null, and
   * sorting on it put every undated entry at the bottom no matter how recent —
   * which reshuffled the whole feed every time one was published. Ordering
   * belongs with the ids, paths and state that spec §8 keeps under deterministic
   * control, never the model's.
   */
  publishedAt: string;
  tags: string[];
  media: PublicMedia[];
}

/**
 * Builds the public record from the approved draft record.
 *
 * The id is minted here rather than reusing the draft id: a draft is private
 * and a record is public, and letting one identifier span both would leak the
 * private object's name into a URL that anyone can read.
 */
export function toPublicRecord(record: DraftRecord, now: Date = new Date()): PublicRecord {
  return {
    id: randomId(),
    title: record.title,
    summary: record.summary,
    body: record.body,
    eventDate: record.eventDate,
    // Set at publication, which is the moment this function is called from: a
    // draft can sit awaiting approval for days, so neither its creation nor its
    // last update is when it became public.
    publishedAt: now.toISOString(),
    tags: [...record.tags],
    // Text-only publication. The media pipeline fills this in once sanitized
    // derivatives exist to point at.
    media: [],
  };
}
