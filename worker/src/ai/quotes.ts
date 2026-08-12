/**
 * Rejects records that quote something the author never wrote.
 *
 * The first record ever published carried an invented Simon Sinek quotation,
 * from a note that said only that morning coffee was good. The system prompt
 * already forbade inventing anything and the model did it anyway, so this is
 * the deterministic half: a rule the model can ignore is not a safeguard.
 *
 * The test itself is simple — if a quoted span does not appear in what the
 * author actually wrote, the model made it up. Finding the span is the part that
 * needs care, and getting it wrong once cost every long note the author sent.
 */
import type { DraftRecord } from "../drafts/types";

/**
 * Straight and curly pairs, since a model producing prose reaches for
 * typographic quotes as readily as ASCII ones.
 *
 * A quote mark is recognised by where it sits rather than by which character it
 * is, because `'` and `’` are also the apostrophe. Pairing those blindly is what
 * the first version did, and in ordinary prose it pairs contractions: "it's …
 * the team's" became a quotation nobody had written, so a note long enough to
 * contain two apostrophes was rejected on every attempt. A body of 700
 * characters was enough to manufacture three of them.
 *
 * Hence the boundaries. An opening mark is not preceded by a letter or a digit
 * and a closing one is not followed by one, which is what "it's" and
 * "patients'" fail; an apostrophe inside a word is allowed to sit within a span
 * rather than end it, so a genuine quotation containing a contraction is still
 * caught whole. Newlines are excluded as well: the title, summary and body are
 * searched as one string, and a span running from one field into the next is
 * another quotation nobody wrote.
 */
const QUOTE_PATTERNS = [
  /(?<![\p{L}\p{N}])"([^"\n]+)"(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])'((?:[^'\n]|'(?=[\p{L}\p{N}]))+)'(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])“([^”\n]+)”(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])‘((?:[^’\n]|’(?=[\p{L}\p{N}]))+)’(?![\p{L}\p{N}])/gu,
];

/**
 * Below this, a quoted fragment is punctuation or emphasis rather than a
 * quotation — a single quoted word, or an apostrophe the pattern mistook for a
 * pair. Attribution needs a sentence to be worth attributing.
 */
const MIN_QUOTE_LENGTH = 25;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const span = match[1].trim();
      if (span.length >= MIN_QUOTE_LENGTH) spans.push(span);
    }
  }
  return spans;
}

/**
 * The quotation, if the record contains one the author's text does not.
 *
 * Null means nothing was invented. `sources` is everything the author is
 * responsible for — the note, and for an edit the record being revised — so a
 * quote the author put there themselves survives.
 */
export function inventedQuotation(record: DraftRecord, sources: string[]): string | null {
  const allowed = normalise(sources.join(" \n "));
  const candidates = [record.title, record.summary ?? "", record.body ?? ""].join("\n");

  for (const span of quotedSpans(candidates)) {
    if (!allowed.includes(normalise(span))) return span;
  }

  return null;
}
