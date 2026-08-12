/**
 * The author's own words, as a record, with no model anywhere in it.
 *
 * Every other route to a record runs the note through Workers AI, which is the
 * point of the bot — but it means the author cannot publish a sentence they
 * wrote and have it appear as they wrote it. This is the way out: pure, local,
 * and incapable of inventing anything, because the only text it can put in a
 * record is text it was handed.
 *
 * The first line is the title and the rest is the body. A convention rather than
 * a guess: the author decides what the heading says by writing it first, and
 * nothing about the result depends on a model's reading of the note.
 */
import { MAX_TITLE } from "../ai/schema";
import type { DraftRecord } from "./types";

/**
 * Cuts an opening line down to a title, at a word boundary where there is one.
 *
 * The ellipsis has to fit inside the limit too, which is the -1: a title that
 * overshoots is exactly what the caller is trying to avoid.
 */
function shorten(line: string): string {
  const room = MAX_TITLE - 1;
  const cut = line.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");

  // Falling back to a hard cut for a line with no spaces in its second half —
  // one very long word, or a script that does not separate them — rather than
  // trimming it back to almost nothing.
  const kept = lastSpace > room / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}

/**
 * The record the author's message becomes when nothing is allowed to rewrite it.
 *
 * Null when there is nothing to publish, which a photo sent without a caption
 * genuinely is: the caller decides what to say about that.
 *
 * `summary`, `eventDate` and `tags` stay empty on purpose. Every one of them
 * would have to be inferred from the text, and inferring is the thing this
 * route exists to avoid — an empty field is honest, where a guessed one is the
 * model's work under another name.
 */
export function verbatimRecord(text: string): DraftRecord | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const breakAt = trimmed.indexOf("\n");
  const opening = (breakAt === -1 ? trimmed : trimmed.slice(0, breakAt)).trim();
  const rest = breakAt === -1 ? "" : trimmed.slice(breakAt + 1).trim();

  const record = { summary: null, eventDate: null, tags: [], media: [] };

  // The ordinary case: a short line at the top is a heading, and the author put
  // it there.
  if (opening.length <= MAX_TITLE) {
    return { ...record, title: opening, body: rest === "" ? null : rest };
  }

  // A long opening line is prose rather than a heading. It is shortened for the
  // title, and the message is kept whole as the body — the alternative is
  // dropping the end of the author's first sentence, on a route whose whole
  // promise is that nothing is dropped.
  return { ...record, title: shorten(opening), body: trimmed };
}
