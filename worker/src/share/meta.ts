/**
 * What a shared activity link says when something previews it.
 *
 * The site is static: `site/vite.config.ts` writes one title and one set of
 * `og:` tags into `/activities/index.html` at build time, and at build time no
 * record exists to describe. A crawler asked to preview
 * `/activities/?v=morning-run` runs no JavaScript, so it reads those build-time
 * tags and shows the whole feed however specific the link was.
 *
 * This module is the answer to "what should that page have said instead", as
 * pure text. Nothing here fetches, reads a bucket, reads the profile or knows
 * about a request — preview.ts does all of that — which is what lets every rule
 * below be tested against the exact HTML the site actually serves. It is the
 * split `site/src/head.ts` already draws for the same tags on the site's side:
 * the caller works out *what* to say, this decides how it is said, and a test
 * run needs nobody's profile to check it.
 *
 * The tags are rewritten rather than added to. The build's own set is removed
 * first, so a page can never carry two `og:title`s and leave the crawler to
 * pick.
 */
import { activityUrl } from "../content/urls";
import type { PublicRecord } from "../content/records";

/**
 * HTML-escapes an attribute value.
 *
 * A copy of the site's `escape` in `site/src/head.ts`, duplicated for the
 * reason `content/urls.ts` duplicates the slug rule: the site and the Worker
 * are separate builds, and the site's module reads `import.meta.env`, which
 * does not exist in a Worker. The tests mirror the site's cases.
 */
export function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * How much of the record a preview card shows before the platform cuts it
 * itself. LinkedIn and Slack both truncate well before this; the point of the
 * limit is that what arrives is a whole sentence rather than a paragraph
 * chopped mid-word by somebody else's renderer.
 */
const DESCRIPTION_MAX_LENGTH = 200;

/** The portrait every other page previews with, and the fallback for a record with no media. */
const PROFILE_IMAGE_PATH = "/media/profile/hero-800.webp";

export interface MetaEnvironment {
  /**
   * Whose portfolio this is, for the half of the title after the activity.
   * Passed in rather than read from the profile here, so this module needs
   * nobody's details to be tested.
   */
  displayName: string;
  /** Public origin of the site, for the canonical link and `og:url`. */
  siteBaseUrl: string;
  /**
   * Public media bucket base. Empty in a deployment that has none, which is why
   * the image is dropped rather than pointed at nothing — the rule
   * `site/src/head.ts` already follows for the same tag.
   */
  mediaBaseUrl: string;
}

export interface ActivityMeta {
  /** The whole `<title>`, name included, exactly as the page sets it client-side. */
  title: string;
  description: string;
  /** Absolute already: media URLs are built from the media bucket's own origin. */
  image: string | null;
  url: string;
}

/**
 * `text` up to `room` characters, ending where a word does.
 *
 * Trailing punctuation goes with it: a cut landing just after a comma reads as
 * ", …", which looks like part of the sentence rather than like what replaced
 * the rest of it. The same rule `site/src/activity.ts` cuts a listing card with.
 */
function cutAtWord(text: string, room: number): string {
  if (text.length <= room) return text;

  const head = text.slice(0, room);
  // Where the last word of the slice starts: that is the word the cut fell in
  // the middle of. A word longer than the whole allowance has no boundary to
  // cut at, and half a word beats an empty card.
  const boundary = head.search(/\s\S*$/u);
  const whole = boundary > 0 ? head.slice(0, boundary) : head;
  return `${whole.replace(/[\s.,;:!?—–-]+$/u, "")}…`;
}

/**
 * The picture the card leads with.
 *
 * `src` rather than `thumbnail` for a photo: the media pipeline points `src` at
 * the widest WebP derivative and `thumbnail` at the narrowest, and a card wants
 * the big one. A video has no still of its own, so its poster — itself the
 * widest of the poster frames — stands in.
 */
function imageFor(record: PublicRecord, mediaBaseUrl: string): string | null {
  for (const item of record.media) {
    if (item.type === "image") return item.src;
    if (item.type === "video" && item.poster) return item.poster;
  }

  const base = mediaBaseUrl.replace(/\/$/, "");
  return base === "" ? null : `${base}${PROFILE_IMAGE_PATH}`;
}

/**
 * What one record's preview says.
 *
 * The title is `<record> — <name>`, which is the string `renderSelection` in
 * `site/src/activities.ts` already sets as `document.title` once the record has
 * loaded. Matching it is the point: the tab, the bookmark and the shared card
 * should not disagree about what the page is called.
 */
export function activityMeta(record: PublicRecord, environment: MetaEnvironment): ActivityMeta {
  // `||` rather than `??`: a profile with the field present but empty would
  // otherwise title every card "Morning run by the river — ".
  const name = environment.displayName || "Portfolio";

  // Whitespace collapsed first: a body carries the author's paragraph breaks,
  // and a newline inside an attribute is a card with a gap in the middle of it.
  const prose = (record.summary ?? record.body ?? "").replace(/\s+/g, " ").trim();

  return {
    title: `${record.title} — ${name}`,
    description: cutAtWord(prose, DESCRIPTION_MAX_LENGTH),
    image: imageFor(record, environment.mediaBaseUrl),
    url: activityUrl(environment.siteBaseUrl, record),
  };
}

/**
 * The tags this record's page carries, in the order they are written.
 *
 * `og:type` is `article` where the build writes `profile`: this page is one
 * dated entry by someone, not the person.
 */
export function metaTags(meta: ActivityMeta): string[] {
  return [
    `<meta name="description" content="${escape(meta.description)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escape(meta.title)}">`,
    `<meta property="og:description" content="${escape(meta.description)}">`,
    meta.image ? `<meta property="og:image" content="${escape(meta.image)}">` : "",
    `<meta property="og:url" content="${escape(meta.url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    // So a crawler that reached this page by some other query string still
    // knows which activity it is looking at.
    `<link rel="canonical" href="${escape(meta.url)}">`,
  ].filter(Boolean);
}

/** The build's own social metadata, which this replaces rather than joins. */
const BUILD_TAGS =
  /[ \t]*<meta[^>]+(?:name="(?:description|twitter:[^"]*)"|property="og:[^"]*")[^>]*>\n?/g;

const TITLE = /<title>[^<]*<\/title>/;

/**
 * The page as served, with this record's preview in place of the feed's.
 *
 * String replacement rather than a parser, for three reasons that all point the
 * same way. `site/vite.config.ts` writes these very tags into this very file
 * exactly like this, so the two ends of the rewrite are the same shape. The
 * document is under a kilobyte and is entirely our own build's output, so there
 * is no third-party markup to be surprised by. And it stays testable under the
 * Worker's plain-vitest setup, where `HTMLRewriter` does not exist — asserting a
 * single selector would mean adopting a workerd test pool for the whole suite.
 *
 * A page whose `<title>` or `</head>` is not where this expects it is returned
 * untouched. Half a rewrite is worse than none: the visitor would get a page
 * with the wrong tags *and* the wrong markup.
 */
export function withActivityMeta(html: string, meta: ActivityMeta): string {
  if (!TITLE.test(html) || !html.includes("</head>")) return html;

  const tags = metaTags(meta);

  return html
    .replace(TITLE, `<title>${escape(meta.title)}</title>`)
    .replace(BUILD_TAGS, "")
    .replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
}
