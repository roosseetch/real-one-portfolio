/**
 * The five fields of a published activity the author can retype, and what
 * counts as a usable new value for each.
 *
 * Pure, and deliberately so: no bucket, no chat, no Telegram. Everything here is
 * "given this record and this typed line, what would the record become" — which
 * is the half of editing worth testing exhaustively, and the half that must not
 * depend on how the question was asked.
 *
 * No model anywhere in it. The author's new wording is stored as the author's
 * new wording, the same promise drafts/verbatim.ts makes on the way in. What the
 * model wrote can be replaced here; nothing here asks it to write again.
 */
import { MAX_BODY, MAX_SUMMARY, MAX_TAG, MAX_TAGS, MAX_TITLE } from "../ai/schema";
import type { PublicRecord } from "../content/records";

export const EDITABLE_FIELDS = ["title", "summary", "body", "eventDate", "tags"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** What each field is called in the chat. The author never sees the property name. */
export const FIELD_LABELS: Record<EditableField, string> = {
  title: "Title",
  summary: "Summary",
  body: "Text",
  eventDate: "Date",
  tags: "Tags",
};

/**
 * Which fields can be emptied.
 *
 * Every one but the title. A record with no title cannot be previewed, rendered
 * or linked to — parseRecord refuses one for the same reason — so "clear it" is
 * not offered for the one field the site cannot do without.
 */
export function isClearable(field: EditableField): boolean {
  return field !== "title";
}

/** A field's value: prose, a tag list, or nothing at all. */
export type FieldValue = string | string[] | null;

export type ParseResult =
  | { status: "ok"; value: FieldValue }
  | { status: "rejected"; reason: string };

/** One place for the short single-letter codes callback_data carries. */
const CODES: Record<string, EditableField> = {
  t: "title",
  s: "summary",
  b: "body",
  d: "eventDate",
  g: "tags",
};

export function fieldCode(field: EditableField): string {
  return Object.keys(CODES).find((code) => CODES[code] === field) as string;
}

export function fieldFromCode(code: string): EditableField | null {
  return CODES[code] ?? null;
}

/**
 * A calendar date, checked as a date rather than as a shape.
 *
 * `2026-02-31` matches the pattern and is not a day that exists. The model's
 * schema only ever pattern-matches, which is defensible for output a model was
 * constrained to produce; a human typing a date by hand gets the stricter check,
 * because a date the site renders as text should at least be one.
 */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Reads a typed line as a new value for one field.
 *
 * Rejections carry the sentence the author is shown, so the reason a value was
 * refused and the words explaining it cannot drift apart. Nothing is silently
 * truncated: a title cut to fit is a title the author did not write, and they
 * are told to shorten it instead.
 */
export function parseFieldValue(field: EditableField, text: string): ParseResult {
  const trimmed = text.trim();

  if (trimmed === "") {
    return {
      status: "rejected",
      reason: isClearable(field)
        ? `That is empty. Send the new ${FIELD_LABELS[field].toLowerCase()}, or press "Clear it" to leave it blank.`
        : "A title cannot be empty — the site has nothing to head the page with. Send one.",
    };
  }

  if (field === "tags") return parseTagList(trimmed);

  if (field === "eventDate") {
    return isCalendarDate(trimmed)
      ? { status: "ok", value: trimmed }
      : {
          status: "rejected",
          reason: "I need the date as YYYY-MM-DD — 2026-08-12, say. That is what the site sorts and shows.",
        };
  }

  const limit = field === "title" ? MAX_TITLE : field === "summary" ? MAX_SUMMARY : MAX_BODY;
  if (trimmed.length > limit) {
    return {
      status: "rejected",
      reason: `That ${FIELD_LABELS[field].toLowerCase()} is ${trimmed.length} characters and the limit is ${limit}. Shorten it and send it again.`,
    };
  }

  // A title is a heading, and a heading is one line. Newlines pasted into one
  // would render as spaces anyway, so they are collapsed rather than refused.
  return { status: "ok", value: field === "title" ? trimmed.replace(/\s+/g, " ") : trimmed };
}

/**
 * Tags as the author writes them: separated by commas or by lines.
 *
 * Deduplicated case-insensitively, exactly as the model's tags are — "Jogging"
 * and "jogging" would otherwise render as two tags on one record.
 */
function parseTagList(text: string): ParseResult {
  const tags: string[] = [];

  for (const entry of text.split(/[,\n]/)) {
    const tag = entry.trim();
    if (tag === "") continue;

    if (tag.length > MAX_TAG) {
      return {
        status: "rejected",
        reason: `"${tag.slice(0, 20)}…" is longer than a tag can be (${MAX_TAG} characters). Send the list again without it.`,
      };
    }

    if (!tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }

  if (tags.length === 0) {
    return { status: "rejected", reason: "I could not find a tag in that. Separate them with commas." };
  }

  if (tags.length > MAX_TAGS) {
    return {
      status: "rejected",
      reason: `That is ${tags.length} tags and the limit is ${MAX_TAGS}. Send a shorter list.`,
    };
  }

  return { status: "ok", value: tags };
}

/** What a field currently says, as a line the author can read back. */
export function describeField(record: PublicRecord, field: EditableField): string {
  if (field === "tags") {
    const tags = record.tags ?? [];
    return tags.length === 0 ? "—" : tags.join(", ");
  }

  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value : "—";
}

/**
 * The record with one field replaced.
 *
 * Returns the record it was given when the value is already what it says, which
 * is what `amendRecord` reads as "nothing to do" — so re-sending the same
 * wording rewrites no chunk and churns no manifest.
 */
export function applyField(
  record: PublicRecord,
  field: EditableField,
  value: FieldValue,
): PublicRecord {
  if (field === "tags") {
    const tags = Array.isArray(value) ? value : [];
    const current = record.tags ?? [];
    const same = tags.length === current.length && tags.every((tag, index) => tag === current[index]);
    return same ? record : { ...record, tags };
  }

  // Null is how every field but the title is emptied; the title cannot reach
  // here with one, because `isClearable` never offers it.
  const next = typeof value === "string" ? value : null;
  if (field === "title") return next === null || next === record.title ? record : { ...record, title: next };

  return next === (record[field] ?? null) ? record : { ...record, [field]: next };
}
