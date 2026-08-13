import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { handleActivityPreview, isActivitiesPath, type PreviewEnv } from "./preview";

const SITE = "https://site.example";

/** The activities page as GitHub Pages serves it, trimmed to the head this rewrites. */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Recent Activities — Someone</title>
    <meta name="description" content="Everything I have published, most recent first.">
    <meta property="og:type" content="profile">
    <meta property="og:title" content="Recent Activities — Someone">
    <meta property="og:description" content="Everything I have published, most recent first.">
    <meta property="og:image" content="https://media.example/media/profile/hero-800.webp">
    <meta name="twitter:card" content="summary_large_image">
  </head>
  <body><div id="app"></div></body>
</html>
`;

let bucket: FakeBucket;
let requested: string[];

function record(over: Partial<PublicRecord> = {}): PublicRecord {
  return {
    id: "abcdefghijkl",
    title: "Morning run by the river",
    summary: "An easy 8 km before work.",
    body: null,
    eventDate: null,
    publishedAt: "2026-07-28T06:00:00.000Z",
    tags: [],
    media: [],
    ...over,
  };
}

/** One chunk of published records, and the manifest that points at it. */
function publish(...records: PublicRecord[]) {
  bucket.objects.set(chunkKey("chunk1"), JSON.stringify(records));
  bucket.objects.set(
    MANIFEST_KEY,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-07-28T06:00:00.000Z",
      recordsPerFile: 10,
      totalRecords: records.length,
      records: [{ id: "chunk1", sha256: "x", count: records.length }],
      latest: "chunk1",
    }),
  );
}

function env(over: Partial<PreviewEnv> = {}): PreviewEnv {
  return {
    CONTENT_BUCKET: bucket.bucket,
    SITE_BASE_URL: SITE,
    MEDIA_BASE_URL: "https://media.example",
    ...over,
  };
}

/**
 * The origin, standing in for GitHub Pages. Records what was asked for, so the
 * pass-through can be shown to be a pass-through rather than something rebuilt.
 */
function origin(body: string = PAGE, init: ResponseInit = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    requested.push(typeof input === "string" ? input : (input as Request).url);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=600" },
      ...init,
    });
  });
}

beforeEach(() => {
  bucket = createFakeBucket();
  requested = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("which paths the route sends here", () => {
  it("recognises the activities page, with or without its index", () => {
    expect(isActivitiesPath("/activities")).toBe(true);
    expect(isActivitiesPath("/activities/")).toBe(true);
    expect(isActivitiesPath("/activities/index.html")).toBe(true);
  });

  it("recognises nothing else", () => {
    // The Cloudflare route matches `/activities*`, which is wider than this.
    // Anything it lets through that is not the page itself is not this Worker's.
    for (const path of ["/", "/contact/", "/activities-archive/", "/activities/morning-run/"]) {
      expect(isActivitiesPath(path)).toBe(false);
    }
  });
});

describe("a link naming one activity", () => {
  it("is titled and described by that activity", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env(),
    );
    const html = await response.text();

    expect(html).toContain("<title>Morning run by the river — ");
    expect(html).toContain('<meta property="og:title" content="Morning run by the river — ');
    expect(html).toContain('<meta property="og:description" content="An easy 8 km before work.">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).not.toContain("Everything I have published");
  });

  it("is answered from the page the origin served, not one built here", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env(),
    );

    expect(requested).toEqual([`${SITE}/activities/?v=morning-run-by-the-river`]);
    expect(await response.text()).toContain('<div id="app"></div>');
  });

  it("keeps the origin's status and headers", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("max-age=600");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  /** The id is the link that is meant to be unambiguous, and it has to keep working. */
  it("is found by its record id as readily as by its slug", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(new Request(`${SITE}/activities/?v=abcdefghijkl`), env());

    expect(await response.text()).toContain("<title>Morning run by the river — ");
  });

  /**
   * A slug comes from a title and two activities can be titled alike. The page
   * shows both; the card can only describe one, so it describes the newest —
   * which is the one a link made today most likely means.
   */
  it("is described by the newest when several share a slug", async () => {
    publish(
      record({ id: "aaaaaaaaaaaa", summary: "The first one.", publishedAt: "2026-01-01T00:00:00.000Z" }),
      record({ id: "bbbbbbbbbbbb", summary: "The second one.", publishedAt: "2026-07-28T06:00:00.000Z" }),
    );
    origin();

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env(),
    );

    expect(await response.text()).toContain('content="The second one.">');
  });
});

describe("everything that is not one activity", () => {
  it("hands the feed back exactly as the origin served it", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(new Request(`${SITE}/activities/`), env());

    expect(await response.text()).toBe(PAGE);
  });

  it("treats an empty ?v= as the feed", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(new Request(`${SITE}/activities/?v=`), env());

    expect(await response.text()).toBe(PAGE);
  });

  /**
   * A record can be unpublished after its link has been shared. The page
   * already answers that case itself — "That activity is not here" — so the
   * preview stays the feed's rather than becoming an invention.
   */
  it("hands back the page untouched when ?v= names nothing", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(new Request(`${SITE}/activities/?v=long-gone`), env());

    expect(await response.text()).toBe(PAGE);
  });

  it("hands back the page untouched when the content bucket cannot be read", async () => {
    // No manifest at all, which is what a bucket that has never been
    // bootstrapped — or one that is briefly unreachable — looks like.
    origin();

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env(),
    );

    expect(await response.text()).toBe(PAGE);
  });

  it("leaves an origin error alone rather than dressing it up", async () => {
    publish(record());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } }),
    );

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env(),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("leaves anything that is not a page alone", async () => {
    publish(record());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env(),
    );

    expect(await response.text()).toBe("{}");
  });
});

/**
 * The guard that keeps the pass-through from eating itself.
 *
 * Cloudflare sends a Worker's `fetch()` to the origin only when the URL matches
 * a *route*. This Worker also answers on its own custom domain, which has no
 * origin behind it, so the same subrequest there would re-enter this handler and
 * loop. Nothing addressed anywhere but the site gets that far.
 */
describe("a request that did not come through the site's route", () => {
  it("is refused rather than fetched", async () => {
    publish(record());
    origin();

    const response = await handleActivityPreview(
      new Request("https://worker.example/activities/?v=morning-run-by-the-river"),
      env(),
    );

    expect(response.status).toBe(404);
    expect(requested).toEqual([]);
  });

  it("is refused when the deployment has no site origin configured", async () => {
    origin();

    const response = await handleActivityPreview(
      new Request(`${SITE}/activities/?v=morning-run-by-the-river`),
      env({ SITE_BASE_URL: "" }),
    );

    expect(response.status).toBe(404);
    expect(requested).toEqual([]);
  });
});
