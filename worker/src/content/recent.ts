/**
 * Finding a published activity from the chat.
 *
 * Three flows now start with the same question — "which activity?" — and each
 * one asks it the same way: the newest few as buttons, or an id, a slug or a
 * pasted link typed by hand. Reposting to LinkedIn asked it first and owned all
 * of this; adding and removing media ask it too, and a second copy of the
 * ordering rule is a second place for it to drift from the site's.
 *
 * Nothing here writes. It reads the manifest and the chunks the site reads, over
 * the same binding, and hands back records.
 */
import { readChunk } from "./chunks";
import { readManifest } from "./manifest";
import { activitySlug } from "./urls";
import type { PublicRecord } from "./records";
import { isValidId } from "../ids";

/** How many activities a chooser offers. Enough to find a recent one, few enough to read at a glance. */
export const CHOICES = 5;

/**
 * How far back a record named by a button is looked for.
 *
 * A press and the work it starts can be minutes apart — a LinkedIn login, a
 * couple of photos being sanitised — so the search is wider than the chooser
 * that offered it.
 */
export const LOOKUP_CHUNKS = 3;

/**
 * The whole archive, for the one flow that has to be able to name *any*
 * activity ever published.
 *
 * Deleting is that flow. The others act on something recent by nature — a
 * repost, a photo added to what was just posted — and paying an R2 read per ten
 * records ever published to answer them would be waste. A deletion is rare,
 * deliberate, and useless if it cannot reach the entry the author wants gone.
 */
export const ALL_CHUNKS = Number.POSITIVE_INFINITY;

export interface RecentEnv {
  CONTENT_BUCKET: R2Bucket;
}

/**
 * Published records, newest first.
 *
 * Chunks are read from the newest backwards and only until `enough` records are
 * in hand: answering "what did I publish recently" does not need the archive,
 * and reading it would cost one more R2 call for every ten records ever
 * published. `maxChunks` is the ceiling for the case where `enough` is never
 * reached — a manifest whose newest chunks are all short.
 */
export async function loadRecords(
  env: RecentEnv,
  enough: number,
  maxChunks: number,
): Promise<PublicRecord[]> {
  const loaded = await readManifest(env.CONTENT_BUCKET);
  if (loaded === null) return [];

  const entries = loaded.manifest.records;
  const collected: PublicRecord[] = [];

  for (let i = entries.length - 1; i >= 0 && entries.length - i <= maxChunks; i--) {
    // unshift, so the array stays in publication order: the position tiebreak
    // below depends on it, exactly as the site's feed does.
    collected.unshift(...(await readChunk(env.CONTENT_BUCKET, entries[i].id)));
    if (collected.length >= enough) break;
  }

  return sortNewestFirst(collected);
}

/**
 * Publication order, newest first.
 *
 * The same rule as site/src/activity.ts: `publishedAt`, never `eventDate` —
 * which is null whenever the author's note named no date, and would drop every
 * undated record to the bottom however recent it is. A record with no
 * `publishedAt` predates the field, which makes it older than every record that
 * has one; among themselves those keep the order the chunks store them in.
 */
export function sortNewestFirst(records: PublicRecord[]): PublicRecord[] {
  const ordered = records.map((record, position) => ({ record, position }));

  ordered.sort((a, b) => {
    const at = typeof a.record.publishedAt === "string" ? a.record.publishedAt : null;
    const bt = typeof b.record.publishedAt === "string" ? b.record.publishedAt : null;

    // ISO 8601 in UTC, so lexicographic order is chronological order.
    if (at !== null && bt !== null) {
      if (at !== bt) return at < bt ? 1 : -1;
    } else if (at !== bt) {
      return at === null ? 1 : -1;
    }

    return b.position - a.position;
  });

  return ordered.map((entry) => entry.record);
}

/** The record a button names, searched over more chunks than the chooser offered. */
export async function findRecord(
  env: RecentEnv,
  recordId: string,
  maxChunks: number = LOOKUP_CHUNKS,
): Promise<PublicRecord | null> {
  if (!isValidId(recordId)) return null;

  const records = await loadRecords(env, Number.POSITIVE_INFINITY, maxChunks);
  return records.find((record) => record.id === recordId) ?? null;
}

/**
 * What the author typed, reduced to the part that could name an activity.
 *
 * A pasted link is the common case — the bot sends one after every publication,
 * so it is the thing nearest to hand — and its `?v=` is the slug. Anything else
 * is taken as the id or the slug itself.
 */
export function referenceFrom(text: string): string {
  const trimmed = text.trim();

  // Parsed rather than pattern-matched, so a query string with more than one
  // parameter, or a fragment after it, cannot be read as part of the slug.
  try {
    const parsed = new URL(trimmed);
    const named = parsed.searchParams.get("v");
    if (named !== null && named.trim() !== "") return named.trim();
    // A link with no ?v= names the feed, not an entry. Falling through to treat
    // the whole URL as a slug would only ever fail to match, so say so by
    // returning nothing rather than searching for it.
    return "";
  } catch {
    // Not a URL. The overwhelmingly common non-link case is an id or a slug
    // pasted on its own.
  }

  return trimmed;
}

/**
 * The record an author named by hand, by id or by slug.
 *
 * Searched over the same window as `findRecord`. The slug is derived rather
 * than stored — it always has been, on the site and in the Worker both — so
 * this recomputes it per record instead of asking the record for it.
 */
export async function findByReference(
  env: RecentEnv,
  text: string,
  maxChunks: number = LOOKUP_CHUNKS,
): Promise<PublicRecord | null> {
  const reference = referenceFrom(text);
  if (reference === "") return null;

  const records = await loadRecords(env, Number.POSITIVE_INFINITY, maxChunks);
  return (
    records.find((record) => record.id === reference) ??
    records.find((record) => activitySlug(record) === reference) ??
    null
  );
}
