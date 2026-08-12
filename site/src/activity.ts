/* Static Activity loader (spec §21).
   Reads the public content bucket only: manifest once, then immutable
   records-{id}.json chunks. No Worker, no database, no runtime API.

   Two places show activities and both start here: the landing page's teaser of
   the two most recent (renderActivityPreview, below) and the /activities page
   that lists them all and addresses one at a time (activities.ts). Everything
   they share — loading, ordering, what a record looks like, and the URL that
   names one — lives in this module, so the two cannot drift. */

import { routeById, routeHref } from "./routes";

export interface ActivityMedia {
  type: "image" | "video";
  src: string;
  thumbnail?: string;
  alt?: string | null;
  caption?: string | null;
  poster?: string;
}

export interface ActivityRecord {
  id: string;
  title: string;
  summary?: string | null;
  body?: string | null;
  eventDate?: string | null;
  /** Stamped by the Worker at publication. Absent on records published before it existed. */
  publishedAt?: string | null;
  tags?: string[];
  media?: ActivityMedia[];
}

interface Manifest {
  schemaVersion: number;
  records: Array<{ id: string }>;
}

const CONTENT_BASE = import.meta.env.VITE_CONTENT_BASE_URL?.replace(/\/$/, "");

/** "/" on a custom domain, "/<repo>/" on a project-pages deployment. Vite fixes it at build time. */
const BASE = import.meta.env.BASE_URL;

const ACTIVITIES = routeById("activities")!;

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function note(section: HTMLElement, message: string) {
  section.querySelector(".activity-note")?.remove();
  section.append(el("p", "activity-note", message));
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.json();
}

function parseChunk(data: unknown): ActivityRecord[] {
  if (!Array.isArray(data)) throw new Error("chunk is not an array");
  return data.filter((r): r is ActivityRecord => {
    return typeof r === "object" && r !== null && typeof (r as ActivityRecord).id === "string" && typeof (r as ActivityRecord).title === "string";
  });
}

async function loadRecords(): Promise<ActivityRecord[]> {
  const manifest = (await fetchJson(`${CONTENT_BASE}/content/manifest.json`)) as Manifest;
  const chunks = await Promise.allSettled(
    manifest.records.map((entry) => fetchJson(`${CONTENT_BASE}/content/records-${entry.id}.json`).then(parseChunk))
  );
  const records: ActivityRecord[] = [];
  for (const chunk of chunks) {
    if (chunk.status === "fulfilled") records.push(...chunk.value);
    else console.warn("Skipping unreadable activity chunk:", chunk.reason);
  }
  return records;
}

/* Publication order, oldest first, for two records and the positions they
   arrived in.

   Records are ordered by when they were published, not by the date their text
   happens to mention. eventDate is what the author's note said, and it is null
   whenever the note named no date — so sorting on it dropped every undated entry
   to the bottom however recent it was, and the whole feed rearranged itself each
   time one was published.

   A record with no publishedAt was published before the field existed, which
   makes it older than every record that has one. Among themselves those keep the
   order they were loaded in, which is the order the chunks store them in, which
   is the order they were published in. */
function comparePublication(
  a: { record: ActivityRecord; position: number },
  b: { record: ActivityRecord; position: number },
): number {
  const at = typeof a.record.publishedAt === "string" ? a.record.publishedAt : null;
  const bt = typeof b.record.publishedAt === "string" ? b.record.publishedAt : null;

  if (at !== null && bt !== null) {
    // ISO 8601 in UTC, so lexicographic order is chronological order.
    if (at !== bt) return at < bt ? -1 : 1;
  } else if (at !== bt) {
    return at === null ? -1 : 1;
  }

  return a.position - b.position;
}

export function sortRecords(records: ActivityRecord[], ascending: boolean): ActivityRecord[] {
  // The position is carried explicitly rather than left to the sort's stability,
  // because it is the tiebreak itself: reversing for newest-first has to reverse
  // two records sharing a timestamp too.
  const ordered = records.map((record, position) => ({ record, position }));
  ordered.sort((a, b) => (ascending ? comparePublication(a, b) : -comparePublication(a, b)));
  return ordered.map((entry) => entry.record);
}

/** Long enough for a real title, short enough that a shared link stays readable. */
const SLUG_MAX_LENGTH = 60;

/**
 * The readable half of an activity's URL: /activities/?v=morning-run-by-the-river.
 *
 * Derived from the title rather than stored on the record. A published record is
 * immutable and none of the ones already in the bucket carry a slug, so a stored
 * one would have to be backfilled into files that must never be rewritten.
 *
 * This is deliberately not an identifier: two records can be titled alike and
 * would slug alike, which is why selectRecords returns a list and the page shows
 * every match. A link that has to be unambiguous can use the record id, which
 * selectRecords accepts in the same parameter.
 */
export function activitySlug(record: ActivityRecord): string {
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

/**
 * The records a `?v=` value names: none, one, or the several that share a slug.
 *
 * The id is tried first and exactly. A slug is derived from a title and a title
 * can be anything, so a record could in principle be titled as another record's
 * id — and the id is the link that is supposed to be unambiguous.
 */
export function selectRecords(records: ActivityRecord[], value: string): ActivityRecord[] {
  const byId = records.filter((record) => record.id === value);
  if (byId.length > 0) return byId;
  return records.filter((record) => activitySlug(record) === value);
}

/** This record's own page. */
export function activityHref(record: ActivityRecord): string {
  return `${routeHref(BASE, ACTIVITIES)}?v=${encodeURIComponent(activitySlug(record))}`;
}

/** The whole list. */
export function activitiesHref(): string {
  return routeHref(BASE, ACTIVITIES);
}

export interface RecordOptions {
  /**
   * Where this record's title links to. Left out on the page that already shows
   * this record on its own, where the link would point at itself.
   */
  href?: string;
  /**
   * Heading level for the title, so a record shown alone is not an h3 under
   * nothing. "h1" on the page that is this one record: there the title is the
   * page's heading, and no other heading is above it.
   */
  heading?: "h1" | "h2" | "h3";
  /**
   * Cut the text to a card-sized excerpt, for the views that show many records
   * at once. Needs `href`: a card with nowhere to link to would cut the text and
   * leave no way to read the rest of it.
   */
  excerpt?: boolean;
}

/**
 * The body, split where the author left a blank line.
 *
 * This used to be one `<p>` holding the whole body, which is fine for the
 * model's output — it writes a paragraph — and wrong for anything else: HTML
 * collapses newlines, so a note published in the author's own words lost every
 * paragraph break it had and arrived as one unbroken block. A record whose body
 * has no blank lines is unchanged by this, which is nearly all of them.
 *
 * Single newlines inside a paragraph survive too, via `white-space: pre-line`
 * in the stylesheet. Splitting on those as well would turn a wrapped line into
 * paragraphs the author did not write.
 */
function paragraphsOf(body: string | null | undefined): string[] {
  if (!body) return [];

  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

interface TextBlock {
  /** The class the card renders this paragraph with — summary or body. */
  className: string;
  text: string;
}

/** A record's prose, in the order and the classes a card shows it in. */
function textOf(record: ActivityRecord): TextBlock[] {
  const blocks: TextBlock[] = [];
  if (record.summary) blocks.push({ className: "activity-summary", text: record.summary });
  for (const text of paragraphsOf(record.body)) blocks.push({ className: "activity-body", text });
  return blocks;
}

/**
 * How much prose a card shows on a page that is listing records rather than
 * showing one. Roughly a short paragraph — enough to tell one activity from
 * another, little enough that the record below it is still on the screen.
 *
 * Characters rather than a CSS line clamp, for two reasons. A clamp applies to
 * one element, so a note of five paragraphs would be five clamped paragraphs and
 * still fill the page; and nothing in the document would say whether anything
 * had been hidden, so the link offering the rest would appear on cards that are
 * already showing all of it.
 */
const EXCERPT_MAX_LENGTH = 240;

/**
 * Overflow small enough that cutting is not worth it. Trading the last line of a
 * note for an ellipsis and a second trip saves nobody any scrolling.
 */
const EXCERPT_GRACE = 60;

/**
 * `text` up to `room` characters, ending where a word does.
 *
 * Trailing punctuation goes with it. A cut landing just after a comma reads as
 * ", …", which looks like part of the sentence rather than like what replaced
 * the rest of it.
 */
function cutAtWord(text: string, room: number): string {
  if (room <= 0) return "";

  const head = text.slice(0, room);
  // Where the last word of the slice starts: that is the word the cut fell in
  // the middle of. A word longer than the whole allowance has no boundary to cut
  // at, and half a word beats an empty card.
  const boundary = head.search(/\s\S*$/u);
  const whole = boundary > 0 ? head.slice(0, boundary) : head;
  return whole.replace(/[\s.,;:!?—–-]+$/u, "");
}

/** The blocks a listing card shows, and whether anything was left behind. */
function excerptOf(blocks: TextBlock[]): { blocks: TextBlock[]; cut: boolean } {
  const total = blocks.reduce((length, block) => length + block.text.length, 0);
  if (total <= EXCERPT_MAX_LENGTH + EXCERPT_GRACE) return { blocks, cut: false };

  const kept: TextBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    const room = EXCERPT_MAX_LENGTH - used;
    if (block.text.length <= room) {
      kept.push(block);
      used += block.text.length;
      continue;
    }
    const head = cutAtWord(block.text, room);
    if (head) kept.push({ ...block, text: `${head}…` });
    break;
  }
  return { blocks: kept, cut: true };
}

export function renderRecord(record: ActivityRecord, options: RecordOptions = {}): HTMLElement {
  const card = el("article", "activity-card");

  const heading = el(options.heading ?? "h3");
  if (options.href) {
    const link = el("a", "activity-card-link", record.title) as HTMLAnchorElement;
    link.href = options.href;
    heading.append(link);
  } else {
    heading.textContent = record.title;
  }
  card.append(heading);

  if (record.eventDate) card.append(el("p", "activity-date", record.eventDate));

  const text = textOf(record);
  const shown = options.excerpt && options.href ? excerptOf(text) : { blocks: text, cut: false };
  for (const block of shown.blocks) card.append(el("p", block.className, block.text));

  for (const media of record.media ?? []) {
    if (media.type === "image") {
      const figure = el("figure", "activity-media");
      const img = new Image();
      img.src = media.thumbnail ?? media.src;
      img.alt = media.alt ?? "";
      img.loading = "lazy";
      figure.append(img);
      if (media.caption) figure.append(el("figcaption", undefined, media.caption));
      card.append(figure);
    } else if (media.type === "video") {
      const figure = el("figure", "activity-media");
      const video = document.createElement("video");
      video.src = media.src;
      // preload="none" with a poster: the frame is a WebP of a few tens of KB
      // and shows immediately, while the clip's megabytes are fetched only if
      // someone presses play. Without the poster the element would be a blank
      // box, since nothing has been downloaded to draw.
      const poster = media.poster ?? media.thumbnail;
      if (poster) video.poster = poster;
      video.preload = "none";
      video.controls = true;
      // Or iOS Safari takes the video fullscreen the moment it starts.
      video.playsInline = true;
      // A video has no alt attribute; the same words become its accessible name.
      if (media.alt) video.setAttribute("aria-label", media.alt);
      figure.append(video);
      if (media.caption) figure.append(el("figcaption", undefined, media.caption));
      card.append(figure);
    }
  }
  if (record.tags?.length) {
    const tags = el("p", "activity-tags");
    for (const tag of record.tags) tags.append(el("span", "activity-tag", tag));
    card.append(tags);
  }

  if (shown.cut && options.href) {
    const more = el("a", "activity-read-more", "Read more") as HTMLAnchorElement;
    more.href = options.href;
    // The title is already a link to the same page, but a list of ten cards is
    // ten links reading "Read more" to anyone stepping through them one at a
    // time. This one says which activity it opens.
    more.setAttribute("aria-label", `Read more: ${record.title}`);
    card.append(more);
  }

  return card;
}

/**
 * Loads the feed into a section and handles every state that is not "here are
 * some records": no content bucket configured yet, nothing published, and a
 * bucket that cannot be read. `paint` is called only when at least one record
 * arrived, so no caller has to repeat those three sentences.
 *
 * The caller appends its own container before calling this, because the
 * placeholders go after it and the notes go after them.
 */
export function mountFeed(
  section: HTMLElement,
  skeletonCards: number,
  paint: (records: ActivityRecord[]) => void,
): void {
  if (!CONTENT_BASE) {
    note(section, "Recent activities will appear here soon.");
    return;
  }

  // Placeholder cards rather than a spinner: they occupy roughly the space the
  // real records will, so the page does not lurch when the feed arrives.
  const skeleton = el("div", "activity-list activity-skeleton");
  skeleton.setAttribute("role", "status");
  skeleton.setAttribute("aria-busy", "true");
  skeleton.setAttribute("aria-label", "Loading recent activities");
  for (let i = 0; i < skeletonCards; i++) skeleton.append(el("div", "activity-skeleton-card"));
  section.append(skeleton);

  loadRecords()
    .then((records) => {
      skeleton.remove();
      if (records.length === 0) {
        note(section, "No activities published yet.");
        return;
      }
      paint(records);
    })
    .catch((error) => {
      skeleton.remove();
      console.warn("Activity feed unavailable:", error);
      note(section, "Activities are unavailable right now. Please check back later.");
    });
}

/**
 * The landing page's activities: the newest few, side by side, and a way through
 * to the rest.
 *
 * No sort control — there is nothing to reorder in two cards, and the page that
 * has every record has the control instead.
 */
export function renderActivityPreview(section: HTMLElement, title: string, limit = 2) {
  section.append(el("h2", undefined, title));

  const list = el("div", "activity-list activity-preview");
  section.append(list);

  mountFeed(section, limit, (records) => {
    const newest = sortRecords(records, false).slice(0, limit);
    list.replaceChildren(
      ...newest.map((record) => renderRecord(record, { href: activityHref(record), excerpt: true })),
    );

    const more = el("a", "activity-more", "See all activities") as HTMLAnchorElement;
    more.href = activitiesHref();
    section.append(more);
  });
}
