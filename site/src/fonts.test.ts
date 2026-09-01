import { describe, expect, it } from "vitest";

import { FONT_FACES, fontFaceStyle, fontPreloadLinks, fontSources } from "./fonts";

const MEDIA = "https://media.test";

describe("where a face is fetched from", () => {
  it("asks the media bucket first and Google only after it", () => {
    const [face] = FONT_FACES;

    expect(fontSources(face, MEDIA)).toEqual([
      `${MEDIA}/fonts/${face.file}`,
      face.fallback,
    ]);
  });

  /**
   * A local `npm run dev` has no bucket. Unlike the icon, which is simply
   * dropped, the design is unreadable in the wrong face — so the fallback
   * carries the page rather than nothing doing.
   */
  it("falls back to Google alone when the build has no media bucket", () => {
    expect(fontSources(FONT_FACES[0], undefined)).toEqual([FONT_FACES[0].fallback]);
  });

  /**
   * The base is the one value here that reaches the inside of a `<style>`
   * element, where a `</style>` would end the block and spill the rest into the
   * document. It comes from the deployment's environment rather than a visitor,
   * so this is a guard — but a build variable should not be able to reshape the
   * page.
   */
  it("ignores a media base that is not a plain URL", () => {
    const sources = fontSources(FONT_FACES[0], "https://media.test/</style><script>x()</script>");

    expect(sources).toEqual([FONT_FACES[0].fallback]);
  });
});

describe("the @font-face block", () => {
  it("declares every face, both sources in order", () => {
    const css = fontFaceStyle(MEDIA);

    for (const face of FONT_FACES) {
      expect(css).toContain(`font-family: "${face.family}"`);
      expect(css).toContain(`url("${MEDIA}/fonts/${face.file}") format("woff2")`);
      expect(css).toContain(`url("${face.fallback}") format("woff2")`);
      expect(css.indexOf(face.file)).toBeLessThan(css.indexOf(face.fallback));
    }
  });

  /** Without a range the second file is fetched too, which is the whole saving. */
  it("gives every face a unicode-range", () => {
    for (const face of FONT_FACES) {
      expect(face.unicodeRange).toMatch(/^U\+/);
    }
    expect(fontFaceStyle(MEDIA).match(/unicode-range:/g)).toHaveLength(FONT_FACES.length);
  });

  /** Invisible text on a slow connection is worse than the wrong serif briefly. */
  it("swaps rather than hiding the words while a face loads", () => {
    expect(fontFaceStyle(MEDIA)).toContain("font-display: swap");
  });

  /**
   * Lora sets the body copy and only its 400 cut is shipped, so a heavier
   * weight in the stylesheet would be answered with a synthesised bold.
   * Cormorant's range is wider because Google serves one file for all of it.
   */
  it("ships Lora at 400 only and Cormorant across its whole range", () => {
    const weights = Object.fromEntries(FONT_FACES.map((face) => [face.family, face.weight]));

    expect(weights["Lora"]).toBe("400");
    expect(weights["Cormorant Garamond"]).toBe("300 700");
  });
});

describe("the preload hints", () => {
  it("hint the latin cuts and not the extension", () => {
    const links = fontPreloadLinks(MEDIA);

    expect(links).toHaveLength(2);
    expect(links.join("\n")).not.toContain("latin-ext");
  });

  /** A font preload without crossorigin is a second request, not a warm cache. */
  it("are made in CORS mode, as a font preload has to be", () => {
    for (const link of fontPreloadLinks(MEDIA)) {
      expect(link).toContain('as="font"');
      expect(link).toContain("crossorigin");
    }
  });

  it("point at Google when there is no bucket to preload from", () => {
    expect(fontPreloadLinks(undefined).join("\n")).toContain("https://fonts.gstatic.com/");
  });
});
