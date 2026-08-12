/**
 * The one call that makes something public on LinkedIn.
 *
 * Like telegram/api.ts, nothing here throws: a LinkedIn outage must not turn a
 * button press into a 500, because Telegram answers a 5xx by redelivering — and
 * a redelivered repost is a duplicate public post.
 *
 * `unauthorized` is a distinct result rather than a kind of failure. It is the
 * expected end of every sixty-day token, and it is the only outcome that has an
 * answer the author can act on.
 */
import type { ComposedPost } from "./compose";

const POSTS_URL = "https://api.linkedin.com/rest/posts";

/**
 * LinkedIn versions its API by month, `YYYYMM`, and supports each version for a
 * minimum of one year before sunsetting it — after which requests naming it
 * fail outright rather than degrading.
 *
 * Pinned rather than computed from the clock: a version that rolled forward on
 * its own would change the request contract on a date nobody chose, in a
 * codebase where nothing else moves without a deploy. The cost is that this has
 * to be bumped deliberately, roughly once a year, against the supported list at
 * https://learn.microsoft.com/en-us/linkedin/marketing/versioning — 202607 is
 * the newest documented as of August 2026, so it is good into mid-2027.
 */
const API_VERSION = "202607";

export type PostResult =
  | { status: "posted"; url: string }
  | { status: "unauthorized" }
  | { status: "failed" };

/**
 * Where a post lives once LinkedIn has it.
 *
 * The URN comes back in a header rather than a body — the API answers 201 with
 * no content — so a missing header means the post exists but cannot be linked
 * to. That is still a success: saying it failed would invite a retry that posts
 * it a second time.
 */
const FEED_URL = "https://www.linkedin.com/feed/update";

export async function publishPost(
  accessToken: string,
  authorUrn: string,
  post: ComposedPost,
): Promise<PostResult> {
  const body = {
    author: authorUrn,
    commentary: post.commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    // The card is described explicitly rather than left to LinkedIn's crawler.
    // /activities/?v=… is one static page serving one set of OG tags for every
    // activity, so a crawled card would name the feed rather than this record.
    content: {
      article: {
        source: post.url,
        title: post.title,
        ...(post.description === "" ? {} : { description: post.description }),
      },
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  let response: Response;
  try {
    response = await fetch(POSTS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "linkedin-version": API_VERSION,
        "x-restli-protocol-version": "2.0.0",
      },
      body: JSON.stringify(body),
    });
  } catch {
    console.warn("LinkedIn post could not be delivered");
    return { status: "failed" };
  }

  // 403 as well as 401: LinkedIn answers a revoked grant with either, and both
  // mean the same thing to the author — log in again.
  if (response.status === 401 || response.status === 403) {
    return { status: "unauthorized" };
  }

  if (!response.ok) {
    // Status only. A rejected post echoes back the commentary, which is the
    // author's own words and has no business in a log.
    console.warn(`LinkedIn post failed with status ${response.status}`);
    return { status: "failed" };
  }

  const urn = response.headers.get("x-restli-id");
  if (urn === null) {
    console.warn("LinkedIn accepted the post but returned no id");
    // No id to build a link from, so the caller has nowhere to point. Still
    // posted: reporting a failure here is what would cause a second one.
    return { status: "posted", url: "" };
  }

  return { status: "posted", url: `${FEED_URL}/${encodeURIComponent(urn)}/` };
}
