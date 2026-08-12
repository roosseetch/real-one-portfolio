/**
 * Where a published record lives on the site.
 *
 * The rule is the site's, not this Worker's — site/src/activity.ts derives the
 * same slug from the same title — but the Worker has to build the link too: it
 * is what the author is sent after publishing, and what a LinkedIn repost
 * carries. Ported rather than imported, because the two are separate builds and
 * the site's version reads `import.meta.env`, which does not exist in a Worker.
 *
 * The tests mirror the site's cases, so a change made to one rule and not the
 * other shows up as a failure rather than as a link that quietly 404s.
 */
import type { PublicRecord } from "./records";

/** Long enough for a real title, short enough that a shared link stays readable. */
const SLUG_MAX_LENGTH = 60;

/** Everything a URL needs from a record: the title it is drawn from, and the id it falls back to. */
export type Addressable = Pick<PublicRecord, "id" | "title">;

export function activitySlug(record: Addressable): string {
  const slug = record.title
    .normalize("NFKD")
    // The combining marks the decomposition left behind: "é" is now "e" + U+0301,
    // and dropping the mark is what turns it into the "e" a URL can carry.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "");

  // A title with nothing ASCII in it — emoji, or a script that does not
  // decompose into Latin — slugs to the empty string, and an empty ?v= names
  // nothing at all. The id is not pretty, but it is always there.
  return slug || record.id;
}

/** This record's own page. */
export function activityUrl(siteBaseUrl: string, record: Addressable): string {
  return `${siteBaseUrl.replace(/\/$/, "")}/activities/?v=${encodeURIComponent(activitySlug(record))}`;
}
