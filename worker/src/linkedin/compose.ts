/**
 * Turns a published record into the text of a LinkedIn post.
 *
 * Two rules shape everything here. The post has a hard ceiling of 3000
 * characters, and the link back to the activity is the point of the post — so
 * the link's room is reserved before a single word is placed, and the prose is
 * what gives way.
 */
import type { PublicRecord } from "../content/records";
import { activityUrl } from "../content/urls";

/** LinkedIn rejects a commentary past this outright. */
const MAX_COMMENTARY = 3000;

/**
 * Characters LinkedIn's "little text" fields reserve.
 *
 * An unescaped one does not degrade the post, it fails it: the API answers 422
 * and nothing is published. A parenthesis in a summary is enough, which makes
 * this the single likeliest way for a repost to break.
 *
 * The backslash is first in the class so it is escaped before it can be used to
 * escape something else.
 */
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;

function escapeLittleText(text: string): string {
  return text.replace(RESERVED, "\\$&");
}

/**
 * The inverse, used only to show the author what LinkedIn will render.
 *
 * Derived from the finished commentary rather than kept alongside it, so the
 * preview is guaranteed to be the very string that was truncated and escaped —
 * approving a preview that was built separately would be approving something
 * else.
 */
function unescapeLittleText(text: string): string {
  return text.replace(/\\([\\|{}@[\]()<>#*_~])/g, "$1");
}

/**
 * A tag as a hashtag: LinkedIn breaks one at the first space or punctuation, so
 * "Study start-up" has to become "#Studystartup" rather than "#Study" followed
 * by loose words.
 */
function hashtag(tag: string): string {
  const word = tag.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "");
  return word === "" ? "" : `#${word}`;
}

/**
 * Cuts escaped text to a length without splitting an escape pair.
 *
 * Truncating after escaping is what keeps the result inside LinkedIn's ceiling —
 * escaping only ever makes text longer, so measuring first would undercount. The
 * cost is that a cut can land between a backslash and the character it protects,
 * which is what the trailing-backslash repair is for.
 */
function cut(escaped: string, limit: number): string {
  if (escaped.length <= limit) return escaped;

  const ellipsis = "…";
  let kept = escaped.slice(0, limit - ellipsis.length);

  // Back off to a word boundary, but only if one is reasonably close: a long
  // unbroken string should not collapse the whole post to nothing.
  const lastSpace = kept.lastIndexOf(" ");
  if (lastSpace > kept.length * 0.6) kept = kept.slice(0, lastSpace);

  // An odd run of trailing backslashes means the cut landed inside an escape
  // pair, and a dangling backslash is itself a malformed little-text field.
  const trailing = /\\*$/.exec(kept)?.[0].length ?? 0;
  if (trailing % 2 === 1) kept = kept.slice(0, -1);

  return `${kept.trimEnd()}${ellipsis}`;
}

export interface ComposedPost {
  /** Ready for the API: escaped, truncated, link included. */
  commentary: string;
  /**
   * The same text as it will actually read on LinkedIn, for the confirmation
   * message. Showing the escaped form would ask the author to approve
   * "\(8 km\)", which is not what anyone would see.
   */
  preview: string;
  url: string;
  /** The card's own title and description, sent explicitly. See post.ts. */
  title: string;
  description: string;
}

/**
 * Builds the whole post.
 *
 * The link goes in the commentary as well as in the article card. The card is
 * LinkedIn's to render and it does not always survive a reshare or a narrow
 * client; a URL in the text always does, and the issue asks for the link to be
 * attached, not for it to be attached conditionally.
 */
export function composePost(siteBaseUrl: string, record: PublicRecord): ComposedPost {
  const url = activityUrl(siteBaseUrl, record);

  const tags = record.tags.map(hashtag).filter((tag) => tag !== "");
  const prose = [record.title, record.summary ?? "", record.body ?? "", tags.join(" ")]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(escapeLittleText)
    .join("\n\n");

  // The URL is not escaped and does not need to be: it is built from the
  // configured site origin and a slug of [a-z0-9-], so it cannot contain a
  // reserved character. Reserving its room first is what guarantees it survives.
  const suffix = `\n\n${url}`;
  const commentary = `${cut(prose, MAX_COMMENTARY - suffix.length)}${suffix}`;

  return {
    commentary,
    preview: unescapeLittleText(commentary),
    url,
    title: record.title,
    // The summary is the card's own line. Falling back to the body rather than
    // leaving it empty, because an empty description renders as a bare domain.
    description: (record.summary ?? record.body ?? "").trim(),
  };
}
