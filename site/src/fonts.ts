/**
 * The two typefaces the design is drawn in, and where a browser gets them.
 *
 * Cormorant Garamond sets every display line and Lora sets every paragraph.
 * Neither is a system font, so the pages either fetch them or render in
 * something the design was not drawn for — there is no third option, and a
 * serif substitute changes the measure of justified prose enough to reflow it.
 *
 * The files are **not in this repository**. They live under `fonts/` in the
 * public media bucket, uploaded once by scripts/upload-fonts.ts, for the reason
 * every other binary is out of tree (spec §1): a repository meant to be reused
 * carries no assets. What is tracked here is the description of each face — its
 * weights, the characters it covers, its object name, and the Google-hosted
 * original it was copied from.
 *
 * That last field is the fallback, and it is a deliberate trade. Listing two
 * `src:` URLs makes the browser's own font machinery walk them in order and
 * fall through on a failed fetch, so a bucket outage costs a round trip rather
 * than the design — no JavaScript, and nothing to get wrong at runtime. The
 * cost is that in exactly that case fonts.gstatic.com learns the visitor's IP
 * and user agent, which is a request this site otherwise refuses to make on a
 * reader's behalf (see the inline LinkedIn mark in sections.ts). It fires only
 * when R2 is unreachable, and profile/design.json says so rather than still
 * claiming no external font service is involved.
 *
 * Pinned URLs rot silently, and only down the path nobody exercises. That is
 * what `npm run fonts:check` is for.
 *
 * Import-free on purpose: scripts/check-fonts.ts reads this module from the
 * root tsconfig, which resolves as NodeNext, while the site's resolves as a
 * bundler. A module with no relative imports of its own is the one shape both
 * agree on (the same arrangement scripts/set-telegram-webhook.ts uses).
 */

/** The characters Google's `latin` slice covers. Every face here is cut the same way. */
const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, " +
  "U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, " +
  "U+2212, U+2215, U+FEFF, U+FFFD";

/** `latin-ext`: the accented letters a Swiss address and a German surname need. */
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, " +
  "U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, " +
  "U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

export interface FontFace {
  /** CSS family name, exactly as `--font-heading` and `--font-body` spell it. */
  family: string;
  /**
   * The `font-weight` descriptor. A range, because both families are variable:
   * one file answers every weight in it, so a range costs nothing a single
   * weight would not have.
   */
  weight: string;
  /** Object name below `fonts/` in the media bucket. Carries the font's version. */
  file: string;
  /** The Google-hosted file this was copied from, used when the bucket is unreachable. */
  fallback: string;
  /** The `unicode-range` descriptor, which is what keeps the second file unfetched. */
  unicodeRange: string;
  /**
   * Whether to preload. Only the `latin` cuts: they set essentially every page,
   * and preloading the extension would spend a connection on glyphs most
   * visitors never see.
   */
  preload: boolean;
}

/**
 * Four files: two families, each in `latin` and `latin-ext`.
 *
 * Cormorant Garamond's range is 300–700 rather than the 300–400 the artboards
 * use, because Google serves the identical file for both — the wider range is
 * free, and it means a heading that later wants a heavier cut has one.
 *
 * Lora stops at 400. Its 400–700 file is 37.8 KB against 21.1 KB, and it sets
 * the body copy, so the extra 16 KB would sit on the critical path to buy a
 * bold this design does not draw. The consequence is that the stylesheet must
 * not ask Lora for a weight above 400: the browser would answer with a
 * synthesised bold, which in an editorial face looks like a mistake.
 */
export const FONT_FACES: FontFace[] = [
  {
    family: "Cormorant Garamond",
    weight: "300 700",
    file: "cormorant-garamond-v21-latin.woff2",
    fallback:
      "https://fonts.gstatic.com/s/cormorantgaramond/v21/co3bmX5slCNuHLi8bLeY9MK7whWMhyjYqXtK.woff2",
    unicodeRange: LATIN,
    preload: true,
  },
  {
    family: "Cormorant Garamond",
    weight: "300 700",
    file: "cormorant-garamond-v21-latin-ext.woff2",
    fallback:
      "https://fonts.gstatic.com/s/cormorantgaramond/v21/co3bmX5slCNuHLi8bLeY9MK7whWMhyjYp3tKgS4.woff2",
    unicodeRange: LATIN_EXT,
    preload: false,
  },
  {
    family: "Lora",
    weight: "400",
    file: "lora-v37-latin.woff2",
    fallback: "https://fonts.gstatic.com/s/lora/v37/0QI6MX1D_JOuGQbT0gvTJPa787weuxJBkq0.woff2",
    unicodeRange: LATIN,
    preload: true,
  },
  {
    family: "Lora",
    weight: "400",
    file: "lora-v37-latin-ext.woff2",
    fallback: "https://fonts.gstatic.com/s/lora/v37/0QI6MX1D_JOuGQbT0gvTJPa787weuxJPkq1umA.woff2",
    unicodeRange: LATIN_EXT,
    preload: false,
  },
];

/**
 * A media base this is willing to write into a stylesheet.
 *
 * Everywhere else the base only ever lands in an attribute, where the worst a
 * strange value does is 404. Here it lands inside a `<style>` element, where a
 * `</style>` in the middle of it would end the block and put the rest of the
 * value into the document as markup. The value comes from the deployment's own
 * environment rather than from a visitor, so this is a guard rather than a
 * defence — but it is one character class, and the alternative is trusting a
 * build variable with the shape of the page.
 */
const SAFE_BASE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\-/]*)?$/;

/** Where a face is fetched from, most-preferred first. */
export function fontSources(face: FontFace, mediaBase?: string): string[] {
  const hosted = mediaBase && SAFE_BASE.test(mediaBase) ? [`${mediaBase}/fonts/${face.file}`] : [];
  return [...hosted, face.fallback];
}

/**
 * The `@font-face` rules, as one `<style>` element for the document head.
 *
 * In the head rather than in styles.css because the URL is not knowable until
 * the build runs: Vite does not substitute `import.meta.env` inside CSS, and a
 * `@font-face` descriptor cannot read a custom property. Emitting it here has a
 * second benefit — the browser finds the fonts in the first response instead of
 * a stylesheet round trip later.
 */
export function fontFaceStyle(mediaBase?: string): string {
  const rules = FONT_FACES.map((face) => {
    const src = fontSources(face, mediaBase)
      .map((url) => `url("${url}") format("woff2")`)
      .join(",\n           ");
    return [
      `      @font-face {`,
      `        font-family: "${face.family}";`,
      `        font-style: normal;`,
      `        font-weight: ${face.weight};`,
      // swap, not optional: the page is prose, and a reader who arrives on a
      // slow connection should get the words in a fallback serif rather than
      // invisible text now and the right face never.
      `        font-display: swap;`,
      `        src: ${src};`,
      `        unicode-range: ${face.unicodeRange};`,
      `      }`,
    ].join("\n");
  });

  return [`<style>`, ...rules, `    </style>`].join("\n");
}

/**
 * Preload hints for the faces above the fold.
 *
 * `crossorigin` is not optional on a font preload: fonts are fetched in CORS
 * mode whatever the `src:` says, and a preload made without it is a second,
 * separate request rather than a warm cache entry.
 *
 * Only the first source is hinted. If the bucket is down that is one wasted
 * request, and the `src:` list still finds the face.
 */
export function fontPreloadLinks(mediaBase?: string): string[] {
  return FONT_FACES.filter((face) => face.preload).map(
    (face) =>
      `<link rel="preload" as="font" type="font/woff2" crossorigin href="${fontSources(face, mediaBase)[0]}">`,
  );
}
