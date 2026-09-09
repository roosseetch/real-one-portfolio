/* Static Activity loader (spec §21).
   Reads the public content bucket only: manifest once, then immutable
   records-{id}.json chunks. No Worker, no database, no runtime API.

   Two places show activities and both start here: the landing page's teaser of
   the two most recent (renderActivityPreview, below) and the /activities page
   that lists them all and addresses one at a time (activities.ts). Everything
   they share — loading, ordering, what a record looks like, and the URL that
   names one — lives in this module, so the two cannot drift. */

import { openLightbox } from "./lightbox";
import { avifFrom, pictureFor } from "./picture";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A record's date, as two parts: "02 Aug" and "2026".
 *
 * Two, because the design sets them on two lines beside a card and on one line
 * under a narrow one, and that is a decision for the stylesheet rather than for
 * a string built here. A date that is not a plain ISO day is passed through
 * whole — the field is free text in the record, and a value this cannot read is
 * still a value the author wrote.
 */
function dateParts(value: string): [string, string] | [string] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return [value];
  const [, year, month, day] = match;
  return [`${day} ${MONTHS[Number(month) - 1] ?? month}`, year];
}

function renderDate(value: string): HTMLElement {
  const wrapper = el("p", "activity-date label tnum");
  dateParts(value).forEach((part, index) => {
    // A space between them even though the stylesheet puts them on two lines:
    // the two spans are one date, and without it the accessible name reads
    // "30 Jul2026".
    if (index > 0) wrapper.append(document.createTextNode(" "));
    wrapper.append(el("span", "activity-date-part", part));
  });
  return wrapper;
}

/**
 * One picture from a media item, whatever kind it is.
 *
 * A clip contributes its poster: the mosaic is a glance at what a record holds,
 * and a `<video>` in a 168px cell is a play button over a frame that has not
 * been downloaded.
 */
function mosaicImage(media: ActivityMedia): HTMLElement {
  const source = media.type === "video" ? (media.poster ?? media.thumbnail) : (media.thumbnail ?? media.src);
  const cell = el("div", "activity-mosaic-cell plate");
  if (!source) return cell;

  const img = new Image();
  img.src = source;
  // The card's title and excerpt say what the record is. Describing each of
  // three pictures again on the way past is noise for a reader stepping through
  // a list; the record's own page gives every image its alt text.
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  // One URL rather than a ladder, because the cell is fixed by the mosaic's
  // grid and always shows the 320px derivative.
  cell.append(pictureFor(img, avifFrom(source)));
  return cell;
}

/**
 * The photo stack at the head of a listing card: one large plate, up to two
 * smaller ones beside it, and a count of whatever did not fit.
 *
 * Degrades all the way down, because records vary: three or more gives the full
 * figure, two drops the second thumbnail, one is a single plate, and none
 * renders nothing at all rather than an empty frame.
 */
function mediaMosaic(record: ActivityRecord, href: string): HTMLElement | null {
  const media = record.media ?? [];
  if (media.length === 0) return null;

  const mosaic = el("div", `activity-mosaic${media.length === 1 ? " is-single" : ""}`);
  mosaic.append(mosaicImage(media[0]));

  if (media.length > 1) {
    const stack = el("div", "activity-mosaic-stack");
    for (const item of media.slice(1, 3)) stack.append(mosaicImage(item));

    const hidden = media.length - 3;
    if (hidden > 0) {
      const overlay = el("div", "activity-mosaic-more tnum", `+${hidden}`);
      // The card's own link already says where this goes, and "+4" read out
      // between a title and an excerpt says nothing a reader can act on.
      overlay.setAttribute("aria-hidden", "true");
      stack.lastElementChild?.append(overlay);
    }
    mosaic.append(stack);
  }

  // Clickable, because the design makes the whole card one target — but not a
  // third stop for a keyboard or a screen reader, which already have the title
  // and "Read more" pointing at the same page.
  const link = el("a", "activity-mosaic-link") as HTMLAnchorElement;
  link.href = href;
  link.tabIndex = -1;
  link.setAttribute("aria-hidden", "true");
  link.append(mosaic);
  return link;
}

/** A long ruled arrow, as the design draws its navigation. Left when `back`. */
export function longArrow(back: boolean, length = 56): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${length} 12`);
  svg.setAttribute("width", String(Math.round(length * 0.79)));
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const d of back
    ? [`M${length} 6H1`, "M7 1 1 6l6 5"]
    : ["M0 6h" + (length - 1), `m${length - 7} 1 6 5-6 5`]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** "01 / 05" — padded, so the counter does not change width as it counts. */
export function counterText(index: number, total: number): string {
  const width = String(total).length;
  return `${String(index + 1).padStart(width, "0")} / ${String(total).padStart(width, "0")}`;
}

/**
 * The widths the sanitiser is asked for.
 *
 * A fourth copy of a list that is also in `.github/workflows/process-media.yml`
 * (DERIVATIVE_WIDTHS, and again in the completeness check beside it) and in
 * `sanitizer/src/main.rs`. It is here because a record stores two URLs and no
 * more — the widest derivative and the narrowest — so the widths in between
 * have to be reconstructed. Changing the ladder means changing it in all three
 * files; a width added here that the pipeline does not write is a 404 in a
 * srcset, which browsers report nowhere.
 */
const DERIVATIVE_WIDTHS = [320, 800, 1200, 1600];

/**
 * Every derivative that exists for one picture, from the widest one's URL.
 *
 * Derived rather than stored, and it is exact rather than a guess: the
 * sanitiser clamps each requested width to the source and drops what that
 * leaves duplicated (`sanitizer/src/image.rs`), so a 960px source produces
 * 320, 800 and 960 — never a 1200. Reading the widest width out of the
 * filename and keeping the ladder strictly below it reproduces that set.
 *
 * Null for anything not named `…-{width}.{ext}`, which is every URL this
 * pipeline did not write.
 *
 * `format` overrides the extension read out of the filename, which is how the
 * same ladder is offered twice — once as WebP on the `<img>` and once as AVIF
 * on the `<source>` in front of it. The two sets have to agree width for width,
 * and deriving both from one function is what makes that true by construction
 * rather than by two lists staying in step.
 */
export function derivativeSrcset(src: string, format?: string): string | null {
  const match = /-(\d+)(\.[a-z0-9]+)$/i.exec(src);
  if (!match) return null;

  const widest = Number(match[1]);
  const stem = src.slice(0, match.index);
  const extension = format ? `.${format}` : match[2];
  const widths = [...DERIVATIVE_WIDTHS.filter((width) => width < widest), widest];
  return widths.map((width) => `${stem}-${width}${extension} ${width}w`).join(", ");
}

/**
 * What a media item shows in the plate: the picture, or the clip itself.
 *
 * `first` is the one the plate opens on. It loads eagerly, because it is the
 * picture the reader came for and deferring it means an empty plate for as long
 * as the observer takes to notice; the rest are off to the side of a scroller
 * and lazy is right for them.
 */
function slideMedia(media: ActivityMedia, first = false): HTMLElement {
  if (media.type === "video") {
    const video = document.createElement("video");
    video.src = media.src;
    // preload="none" with a poster: the frame is a WebP of a few tens of KB and
    // shows immediately, while the clip's megabytes are fetched only if someone
    // presses play. Without the poster the element would be a blank box, since
    // nothing has been downloaded to draw.
    const poster = media.poster ?? media.thumbnail;
    if (poster) video.poster = poster;
    video.preload = "none";
    video.controls = true;
    // Or iOS Safari takes the video fullscreen the moment it starts.
    video.playsInline = true;
    // A video has no alt attribute; the same words become its accessible name.
    if (media.alt) video.setAttribute("aria-label", media.alt);
    return video;
  }

  const img = new Image();
  // `src`, not `thumbnail`. The thumbnail is the 320px derivative — right for a
  // 6rem filmstrip button and for a mosaic cell, and a blur in a plate that
  // renders past 500px. The wider files have always been in the bucket.
  img.src = media.src;
  const srcset = derivativeSrcset(media.src);
  // The plate is height-clamped and contains rather than covers, so however
  // wide the column gets, the picture inside it stops around 46rem.
  const sizes = "(max-width: 48rem) 100vw, 46rem";
  if (srcset) {
    img.srcset = srcset;
    img.sizes = sizes;
  }
  img.alt = media.alt ?? "";
  img.loading = first ? "eager" : "lazy";
  img.decoding = "async";
  // The same ladder in AVIF, or the single widest file when there is no ladder
  // to build — a source that offered fewer widths than the <img> beside it
  // would hand the browser a worse choice than the one it already had.
  const avif = srcset
    ? derivativeSrcset(media.src, "avif")
    : avifFrom(media.src);
  return pictureFor(img, avif, srcset ? sizes : undefined);
}

/**
 * The plate's contents, and the way into the full-screen view.
 *
 * Only a photograph gets the button. A clip carries its own controls, and a
 * button laid over them would swallow the press meant for play.
 */
function slideZoom(
  photos: ActivityMedia[],
  item: ActivityMedia,
  position: number,
  first: boolean,
): HTMLElement {
  const content = slideMedia(item, first);
  if (item.type === "video") return content;

  const button = el("button", "carousel-zoom") as HTMLButtonElement;
  button.type = "button";
  // Numbered within the photographs, which is what the lightbox counts through
  // — a set of two photographs either side of a clip reads "1" and "2" here.
  button.setAttribute("aria-label", `View photo ${position + 1} full size`);
  button.append(content);
  button.addEventListener("click", () => openLightbox(photos, position));
  return button;
}

/**
 * Every photograph and clip a record carries, one at a time.
 *
 * This replaces a column of figures at full width, which on a record with five
 * pictures was a page of pictures with the text somewhere above it. The design
 * shows one plate with ruled arrows, a counter, a caption, and a strip of
 * thumbnails to jump by.
 *
 * Scroll snapping does the paging, so a swipe and a trackpad work with no
 * JavaScript at all; the arrows and the strip drive that same scroll, which
 * keeps one source of truth for where the carousel is — the same arrangement
 * the hobbies carousel used before the rail replaced it. A record with one
 * picture gets the plate and none of the chrome, since there is nothing to
 * navigate.
 */
function mediaCarousel(record: ActivityRecord): HTMLElement | null {
  const media = record.media ?? [];
  if (media.length === 0) return null;

  const carousel = el("div", "media-carousel");
  const single = media.length === 1;
  // What the full-screen view steps through. Clips are left out of it: one
  // already plays in the plate, and arrowing into another here would stack a
  // second player on the first.
  const photos = media.filter((item) => item.type !== "video");

  const track = el("div", "carousel-track");
  if (!single) {
    // The track scrolls, so it has to be reachable by keyboard on its own:
    // someone navigating without a mouse must be able to focus it and use the
    // arrow keys, which the handler below listens for. A bare div cannot carry
    // a name, hence the group role.
    track.tabIndex = 0;
    track.setAttribute("role", "group");
    track.setAttribute("aria-roledescription", "carousel");
    track.setAttribute("aria-label", `${record.title}: ${media.length} items, use arrow keys to browse`);
  }

  media.forEach((item, index) => {
    const slide = el("div", "carousel-slide plate");
    if (!single) {
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", `${index + 1} of ${media.length}`);
    }
    slide.append(slideZoom(photos, item, photos.indexOf(item), index === 0));
    track.append(slide);
  });
  carousel.append(track);

  const caption = el("p", "carousel-caption");
  const setCaption = (index: number) => {
    caption.textContent = media[index]?.caption ?? "";
    caption.hidden = caption.textContent === "";
  };

  if (single) {
    setCaption(0);
    carousel.append(caption);
    return carousel;
  }

  const bar = el("div", "carousel-bar");
  const prev = el("button", "carousel-arrow") as HTMLButtonElement;
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous");
  prev.append(longArrow(true));
  const next = el("button", "carousel-arrow") as HTMLButtonElement;
  next.type = "button";
  next.setAttribute("aria-label", "Next");
  next.append(longArrow(false));

  const counter = el("span", "carousel-counter label tnum");
  // Where in the set the reader is, which is the one thing the plate itself
  // does not say. Polite, so it waits for a gap rather than cutting in.
  counter.setAttribute("aria-live", "polite");

  bar.append(prev, next, counter);
  carousel.append(bar, caption);

  const strip = el("div", "carousel-strip");
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", "Choose an item");
  const thumbs = media.map((item, index) => {
    const button = el("button", "carousel-thumb plate") as HTMLButtonElement;
    button.type = "button";
    button.setAttribute(
      "aria-label",
      item.alt || `${item.type === "video" ? "Clip" : "Photo"} ${index + 1}`,
    );
    const source = item.type === "video" ? (item.poster ?? item.thumbnail) : (item.thumbnail ?? item.src);
    if (source) {
      const img = new Image();
      img.src = source;
      // The button's own label names the item; the picture inside it is the
      // button's face, not a second thing to describe.
      img.alt = "";
      img.loading = "lazy";
      // No ladder here either: a 6rem button shows the 320px derivative and
      // nothing else, which is why the <img> carries no srcset of its own.
      button.append(pictureFor(img, avifFrom(source)));
    }
    button.addEventListener("click", () => scrollToSlide(index));
    strip.append(button);
    return button;
  });
  carousel.append(strip);

  let current = 0;

  function scrollToSlide(index: number) {
    const target = track.children[index] as HTMLElement | undefined;
    if (target) track.scrollTo({ left: target.offsetLeft - track.offsetLeft });
  }

  function sync() {
    // Nearest slide to the track's scroll position, rather than tracking
    // clicks, so swiping and scrolling stay in step with the controls.
    let nearest = 0;
    let smallest = Infinity;
    for (let i = 0; i < track.children.length; i++) {
      const child = track.children[i] as HTMLElement;
      const distance = Math.abs(child.offsetLeft - track.offsetLeft - track.scrollLeft);
      if (distance < smallest) {
        smallest = distance;
        nearest = i;
      }
    }
    current = nearest;
    counter.textContent = counterText(current, media.length);
    setCaption(current);
    thumbs.forEach((thumb, i) => {
      if (i === current) thumb.setAttribute("aria-current", "true");
      else thumb.removeAttribute("aria-current");
    });
    prev.disabled = current === 0;
    next.disabled = current === media.length - 1;
  }

  prev.addEventListener("click", () => scrollToSlide(current - 1));
  next.addEventListener("click", () => scrollToSlide(current + 1));
  track.addEventListener("scroll", sync, { passive: true });
  track.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowLeft") scrollToSlide(current - 1);
    else if (key === "ArrowRight") scrollToSlide(current + 1);
    else return;
    event.preventDefault();
  });

  sync();
  return carousel;
}

export function renderRecord(record: ActivityRecord, options: RecordOptions = {}): HTMLElement {
  const card = el("article", "activity-card");

  // A listing card leads with its pictures and a page showing one record leads
  // with its title; the mosaic is the listing's own figure and never appears on
  // the page that shows every image in full.
  const listing = Boolean(options.href && options.excerpt);
  if (listing && options.href) {
    const mosaic = mediaMosaic(record, options.href);
    if (mosaic) card.append(mosaic);
  }

  const body = el("div", "activity-card-body");

  if (record.eventDate) body.append(renderDate(record.eventDate));

  const text = el("div", "activity-card-text");

  const heading = el(options.heading ?? "h3");
  if (options.href) {
    const link = el("a", "activity-card-link", record.title) as HTMLAnchorElement;
    link.href = options.href;
    heading.append(link);
  } else {
    heading.textContent = record.title;
  }
  text.append(heading);

  // The short gold rule the design sets under the title of a record shown on
  // its own. Not on a listing card, where ten of them would be ten rules.
  if (options.heading === "h1") {
    const rule = el("div", "rule-accent activity-rule");
    rule.setAttribute("aria-hidden", "true");
    text.append(rule);
  }

  const blocks = textOf(record);
  const shown = options.excerpt && options.href ? excerptOf(blocks) : { blocks, cut: false };
  for (const block of shown.blocks) text.append(el("p", block.className, block.text));

  if (!listing) {
    const carousel = mediaCarousel(record);
    if (carousel) text.append(carousel);
  }

  if (record.tags?.length) {
    const tags = el("p", "activity-tags");
    for (const tag of record.tags) tags.append(el("span", "activity-tag label", tag));
    text.append(tags);
  }

  if (shown.cut && options.href) {
    const more = el("a", "activity-read-more", "Read more") as HTMLAnchorElement;
    more.href = options.href;
    // The title is already a link to the same page, but a list of ten cards is
    // ten links reading "Read more" to anyone stepping through them one at a
    // time. This one says which activity it opens.
    more.setAttribute("aria-label", `Read more: ${record.title}`);
    text.append(more);
  }

  body.append(text);
  card.append(body);
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
  // Heading, a rule filling the space beside it, and the way through to the
  // rest — one line, which is how the design opens this section.
  const head = el("div", "activity-head");
  head.append(el("h2", undefined, title));
  const rule = el("div", "rule activity-head-rule");
  rule.setAttribute("aria-hidden", "true");
  head.append(rule);
  section.append(head);

  const list = el("div", "activity-list activity-preview");
  section.append(list);

  mountFeed(section, limit, (records) => {
    const newest = sortRecords(records, false).slice(0, limit);
    list.replaceChildren(
      ...newest.map((record) => renderRecord(record, { href: activityHref(record), excerpt: true })),
    );

    // Added here rather than with the heading, so a feed that is empty or
    // unreachable does not offer a way through to a list that is not there.
    const more = el("a", "activity-more label", "View all activities \u2192") as HTMLAnchorElement;
    more.href = activitiesHref();
    head.append(more);
  });
}
