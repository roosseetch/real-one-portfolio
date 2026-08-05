/**
 * Rejects records that quote something the author never wrote.
 *
 * The first record ever published carried an invented Simon Sinek quotation,
 * from a note that said only that morning coffee was good. The system prompt
 * already forbade inventing anything and the model did it anyway, so this is
 * the deterministic half: a rule the model can ignore is not a safeguard.
 *
 * The test is simple and hard to argue with — if a quoted span does not appear
 * in what the author actually wrote, the model made it up.
 */
import type { DraftRecord } from "../drafts/types";

/**
 * Straight and curly pairs, since a model producing prose reaches for typographic
 * quotes as readily as ASCII ones.
 */
const QUOTE_PATTERNS = [
  /"([^"]+)"/g,
  /'([^']+)'/g,
  /“([^”]+)”/g,
  /‘([^’]+)’/g,
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
