/**
 * The contract the model has to meet, and the check that it did (spec §8).
 *
 * The schema is handed to Workers AI so it constrains generation, and the
 * validator below re-checks the result anyway. Constrained decoding makes
 * malformed output rare, not impossible, and a draft is not the place to find
 * out which.
 *
 * Note what the model is *not* asked for: no ids, no object names, no paths, no
 * URLs, no media entries. Spec §8 puts all of those under deterministic Worker
 * control, and the surest way to honour that is to never ask for them.
 */
import type { DraftRecord } from "../drafts/types";

const MAX_TITLE = 120;
const MAX_SUMMARY = 300;
const MAX_BODY = 4000;
const MAX_TAGS = 8;
const MAX_TAG = 40;

export const RECORD_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short, specific title. No trailing punctuation." },
    summary: { type: "string", description: "One sentence describing what happened." },
    body: { type: "string", description: "The activity written out, in the author's own voice." },
    eventDate: {
      type: ["string", "null"],
      description: "The date the activity happened, as YYYY-MM-DD. Null if the text does not say.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Between one and five short topic tags, each capitalised.",
    },
  },
  required: ["title", "summary", "body", "eventDate", "tags"],
} as const;

/** Trims, then treats an empty string as absent so "" never reaches the site as a value. */
function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, max);
}

/**
 * Returns null for anything that is not a usable record, which the caller
 * treats as a failed attempt worth retrying.
 *
 * `media` is always empty here. A text draft has no media, and the model is
 * never the thing that decides one exists.
 */
export function parseRecord(data: unknown): DraftRecord | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;

  const candidate = data as Record<string, unknown>;

  // The only genuinely required field: a record with no title cannot be
  // previewed or rendered.
  const title = optionalText(candidate.title, MAX_TITLE);
  if (title === null) return null;

  const eventDate = typeof candidate.eventDate === "string" ? candidate.eventDate.trim() : "";

  return {
    title,
    summary: optionalText(candidate.summary, MAX_SUMMARY),
    body: optionalText(candidate.body, MAX_BODY),
    // A date the site cannot sort by is worse than no date, so anything that is
    // not a plain calendar date is dropped rather than passed along.
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : null,
    tags: parseTags(candidate.tags),
    media: [],
  };
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const tags: string[] = [];
  for (const entry of value) {
    const tag = optionalText(entry, MAX_TAG);
    // Deduplicated case-insensitively: "Jogging" and "jogging" would otherwise
    // render as two separate tags on the same record.
    if (tag !== null && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}
