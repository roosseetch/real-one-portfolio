/**
 * The one route that sits in front of the site rather than beside it.
 *
 * Everything else this Worker answers is its own: a Telegram webhook, a
 * callback, the contact form's intake. This handler answers requests for a page
 * GitHub Pages serves, on the site's own hostname, through a Cloudflare route
 * matching `/activities*` and nothing else. It fetches that same static page and
 * changes its `<head>` — the record's title, summary and photo in place of the
 * feed's — so a `?v=` link pasted anywhere previews as the activity it names.
 *
 * It is deliberately the narrowest thing that could work. The site is not
 * rebuilt, no page is generated per activity, and no URL changes: the links
 * already published on LinkedIn are the links this fixes. The landing page,
 * /contact and every asset never reach this Worker at all, because the route
 * does not match them.
 *
 * **Every failure returns the origin's answer untouched.** A missing record, a
 * bucket that will not read, a page whose shape has changed, an outright throw —
 * all of them leave the visitor with exactly the page they have today. The
 * preview is an improvement on a page that already works, and it must never be
 * the reason that page does not.
 */
import facts from "../../../profile/facts.json";
import { ALL_CHUNKS, findByReference, type RecentEnv } from "../content/recent";
import { activityMeta, withActivityMeta } from "./meta";

export interface PreviewEnv extends RecentEnv {
  /** The site's public origin. Also the guard: see `handleActivityPreview`. */
  SITE_BASE_URL: string;
  /** Public media bucket base, for the card's picture. Empty means no picture. */
  MEDIA_BASE_URL: string;
}

/** The paths the Cloudflare route sends here that are actually the activities page. */
const ACTIVITY_PATHS = new Set(["/activities", "/activities/", "/activities/index.html"]);

export function isActivitiesPath(pathname: string): boolean {
  return ACTIVITY_PATHS.has(pathname);
}

function sameHost(request: Request, siteBaseUrl: string): boolean {
  try {
    return new URL(request.url).host === new URL(siteBaseUrl).host;
  } catch {
    return false;
  }
}

/**
 * The static page, with this record's preview written into it.
 *
 * The host check is load-bearing rather than defensive. This Worker also answers
 * on its own custom domain, and Cloudflare only sends a `fetch()` to the origin
 * when the URL matches a *route*; a custom domain has no origin behind it, so
 * the same subrequest there would re-enter this Worker and loop until the
 * platform cut it off. Anything not addressed to the site is left to the
 * router's 404.
 */
export async function handleActivityPreview(request: Request, env: PreviewEnv): Promise<Response> {
  if (!sameHost(request, env.SITE_BASE_URL)) {
    return new Response("Not found", { status: 404 });
  }

  const named = new URL(request.url).searchParams.get("v");

  // The feed itself, which the build already describes correctly.
  if (named === null || named.trim() === "") return fetch(request);

  // Started together: the origin round-trip and the R2 reads are independent,
  // so the lookup costs the visitor nothing but the slower of the two. The
  // whole archive is searched because a permalink to something published last
  // year is exactly the link this exists for.
  const [response, record] = await Promise.all([
    fetch(request),
    findByReference(env, named, ALL_CHUNKS).catch(() => null),
  ]);

  // A `?v=` naming nothing is not an error: the record may have been
  // unpublished since the link was made, and the page says so itself.
  if (record === null) return response;

  // Only a page. An error, a redirect, or anything that is not HTML is the
  // origin's to answer.
  if (!response.ok) return response;
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;

  // Cloned before the body is read, so a stream that fails halfway still leaves
  // an untouched response to hand back. Reading consumes the original, and a
  // page the origin served is not something to lose to a rewrite.
  const untouched = response.clone();

  try {
    const html = await response.text();
    const meta = activityMeta(record, {
      // The profile is read here rather than in meta.ts, which is kept free of
      // it so its rules can be tested without anybody's details — the same
      // split site/src/head.ts draws against site/vite.config.ts.
      displayName: facts.displayName,
      siteBaseUrl: env.SITE_BASE_URL,
      mediaBaseUrl: env.MEDIA_BASE_URL,
    });

    // Headers carried over rather than rebuilt, so the origin's caching and
    // content type survive; only the length changes, and that is recomputed
    // for us because the body is a string.
    const headers = new Headers(response.headers);
    headers.delete("content-length");

    return new Response(withActivityMeta(html, meta), { status: response.status, headers });
  } catch (error) {
    console.error(`Could not rewrite the activity preview: ${(error as Error).message}`);
    return untouched;
  }
}
