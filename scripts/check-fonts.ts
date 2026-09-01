/**
 * Every font URL the pages hand a browser still answers.
 *
 * site/src/fonts.ts declares two sources per face: the copy in the media
 * bucket, and the Google-hosted original it was made from. The second one only
 * ever runs when the first fails, which is the property that makes it useful
 * and also the property that makes it rot unnoticed — Google re-cuts a family,
 * the version in the path moves, and nothing says so until the day the bucket
 * is down and the fallback is needed. This asks both, out loud, on a schedule
 * of someone's choosing rather than of an outage's.
 *
 * Two modes, because the two URLs are known at different times:
 *
 *   default   The pinned fonts.gstatic.com URLs. Needs no configuration, so CI
 *             runs it on every pull request, forks included.
 *
 *   + bucket  If MEDIA_BASE_URL is set in the environment, the R2 objects are
 *             checked too. That value is a deployment value, so it is never in
 *             tracked source and never in a fork's environment.
 *
 * Usage:
 *   npm run fonts:check
 *   MEDIA_BASE_URL=https://media.example npm run fonts:check
 *
 * Exit code 0 = every URL checked returned 200, 1 = anything else.
 */
import { FONT_FACES, fontSources } from "../site/src/fonts.js";

const mediaBase = process.env.MEDIA_BASE_URL?.replace(/\/$/, "");

if (!mediaBase) {
  console.log("MEDIA_BASE_URL is not set: checking the Google fallbacks only.\n");
}

interface Result {
  url: string;
  ok: boolean;
  detail: string;
}

/**
 * HEAD, then GET on anything that is not a plain 200.
 *
 * Some CDNs answer HEAD from a different path than GET, and a 405 to a HEAD is
 * not evidence the file is gone. The GET is discarded unread; these are tens of
 * kilobytes and this runs once per pull request.
 */
async function check(url: string): Promise<Result> {
  for (const method of ["HEAD", "GET"] as const) {
    let response: Response;
    try {
      response = await fetch(url, { method, redirect: "follow" });
    } catch (error) {
      return { url, ok: false, detail: `${(error as Error).message}` };
    }
    if (response.ok) {
      const type = response.headers.get("content-type") ?? "no content-type";
      const length = response.headers.get("content-length");
      // R2 serves whatever it was told at upload time, and a woff2 delivered as
      // application/octet-stream is a face some browsers decline to use.
      const ok = type.startsWith("font/woff2");
      return {
        url,
        ok,
        detail: ok
          ? `200  ${type}${length ? `  ${(Number(length) / 1024).toFixed(1)} KiB` : ""}`
          : `200 but served as ${type}, not font/woff2`,
      };
    }
    if (method === "GET") return { url, ok: false, detail: `HTTP ${response.status}` };
  }
  return { url, ok: false, detail: "unreachable" };
}

const urls = FONT_FACES.flatMap((face) => fontSources(face, mediaBase));
const results = await Promise.all(urls.map(check));

for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.detail.padEnd(28)}  ${result.url}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} font URLs did not answer as expected.`);
  process.exit(1);
}
console.log(`\n${results.length} font URLs, all good.`);
