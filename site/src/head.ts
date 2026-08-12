/**
 * The tags the build writes into every page's `<head>`.
 *
 * Split out of vite.config.ts for the reason routes.ts is its own module: two
 * readers and one list. The config works out *what* to say — it reads
 * ../profile/*.json for the name, the headline and the opening paragraph — and
 * this decides how it is said. The split is what lets the tags be tested at all:
 * the site's suite deliberately does not load vite.config.ts, precisely so a
 * test run needs no profile (see vitest.config.ts), and nothing here reads one.
 *
 * Every tag is optional in the same way: a value the deployment did not
 * configure produces no tag rather than a tag pointing at nothing.
 */

/** HTML-escapes an attribute value. Profile text is prose, and prose contains quotes. */
export function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface HeadInput {
  /** This page's full title, already combined with the profile's name. */
  pageTitle: string;
  /** This page's description meta. */
  description: string;
  /**
   * Public media bucket base, trailing slash already stripped. Undefined in a
   * build with none configured — a local `npm run dev`, most often — which is
   * why every tag that needs it is dropped rather than emitted half-built.
   */
  mediaBase?: string;
}

/**
 * The social metadata and the site icon, in the order they are written.
 *
 * The icon lives in the media bucket rather than in `public/`, beside the
 * portrait and for the same reason: a logo is one person's brand mark, and a
 * repository meant to be reused for someone else carries no images at all
 * (spec §1). The cost is that a build with no media base has no icon, which is
 * a missing tab picture and nothing more.
 */
export function headTags({ pageTitle, description, mediaBase }: HeadInput): string[] {
  return [
    `<meta name="description" content="${escape(description)}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:title" content="${escape(pageTitle)}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    mediaBase ? `<meta property="og:image" content="${mediaBase}/media/profile/hero-800.webp">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    // PNG rather than the WebP the rest of media/profile/ is. A tab icon is the
    // one image here read by the browser's chrome rather than by its renderer,
    // and Safari's support for a WebP one is not something a logo should rest
    // on. At this size the file is under a kilobyte either way.
    mediaBase
      ? `<link rel="icon" type="image/png" sizes="32x32" href="${mediaBase}/media/profile/favicon-32.png">`
      : "",
    // Doubles as the icon a phone uses for a site saved to the home screen,
    // which is the only reason a second size earns its request.
    mediaBase
      ? `<link rel="apple-touch-icon" sizes="180x180" href="${mediaBase}/media/profile/favicon-180.png">`
      : "",
  ].filter(Boolean);
}
