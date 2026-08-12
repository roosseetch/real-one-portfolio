import { describe, expect, it } from "vitest";

import { escape, headTags } from "./head";

const INPUT = {
  pageTitle: "A Name — A Headline",
  description: "One paragraph about someone.",
  mediaBase: "https://media.test",
};

describe("the site icon", () => {
  it("points the tab icon at the logo in the media bucket", () => {
    expect(headTags(INPUT)).toContain(
      '<link rel="icon" type="image/png" sizes="32x32" href="https://media.test/media/profile/favicon-32.png">',
    );
  });

  it("offers the larger one for a home screen", () => {
    expect(headTags(INPUT)).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="https://media.test/media/profile/favicon-180.png">',
    );
  });

  /**
   * A local `npm run dev` has no media bucket. A tag pointing at
   * `undefined/media/profile/...` would be a request that can only 404, so
   * there is no tag at all.
   */
  it("emits no icon when the build has no media bucket", () => {
    const tags = headTags({ ...INPUT, mediaBase: undefined });

    expect(tags.some((tag) => tag.includes("rel=\"icon\""))).toBe(false);
    expect(tags.some((tag) => tag.includes("apple-touch-icon"))).toBe(false);
    // The tags that need nothing from the bucket are still there.
    expect(tags.some((tag) => tag.includes('property="og:title"'))).toBe(true);
  });
});

describe("the social metadata beside it", () => {
  it("still describes the page and its image", () => {
    const tags = headTags(INPUT).join("\n");

    expect(tags).toContain('<meta property="og:title" content="A Name — A Headline">');
    expect(tags).toContain('<meta property="og:description" content="One paragraph about someone.">');
    expect(tags).toContain('content="https://media.test/media/profile/hero-800.webp"');
  });

  /** Profile text is prose, and prose contains the characters that end an attribute. */
  it("escapes a description that would otherwise break out of its attribute", () => {
    const tags = headTags({ ...INPUT, description: 'She said "hello" & <waved>' });

    expect(tags.join("\n")).toContain(
      '<meta name="description" content="She said &quot;hello&quot; &amp; &lt;waved&gt;">',
    );
  });

  it("escapes the ampersand first, so an escape is not escaped twice", () => {
    expect(escape("&lt;")).toBe("&amp;lt;");
  });
});
