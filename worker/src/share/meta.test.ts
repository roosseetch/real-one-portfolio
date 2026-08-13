import { describe, expect, it } from "vitest";

import type { PublicRecord } from "../content/records";
import { activityMeta, escape, metaTags, withActivityMeta } from "./meta";

/**
 * The activities page as GitHub Pages actually serves it — the build's output
 * copied verbatim, hashed asset names and stray indentation included.
 *
 * A fixture rather than a hand-written approximation on purpose. This module
 * rewrites HTML by pattern, and the only thing that makes that safe is that the
 * patterns are matched against the very shape `site/vite.config.ts` emits. A
 * change to what the build writes has to fail here, not in production.
 */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Recent Activities — A Name</title>
    <script type="module" crossorigin src="/assets/activities-xcocYKDW.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/shell-3mRbL9I0.js">
    <link rel="stylesheet" crossorigin href="/assets/shell-Cz3lXKHx.css">
      <meta name="description" content="Everything I have published, most recent first.">
    <meta property="og:type" content="profile">
    <meta property="og:title" content="Recent Activities — A Name">
    <meta property="og:description" content="Everything I have published, most recent first.">
    <meta property="og:image" content="https://media.example/media/profile/hero-800.webp">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="icon" type="image/png" sizes="32x32" href="https://media.example/media/profile/favicon-32.png">
    <link rel="apple-touch-icon" sizes="180x180" href="https://media.example/media/profile/favicon-180.png">
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`;

const ENVIRONMENT = {
  displayName: "A Name",
  siteBaseUrl: "https://site.example",
  mediaBaseUrl: "https://media.example",
};

function record(over: Partial<PublicRecord> = {}): PublicRecord {
  return {
    id: "abcdefghijkl",
    title: "Morning run by the river",
    summary: "An easy 8 km before work.",
    body: "Cool air, quiet paths, and a good pace.",
    eventDate: "2026-07-28",
    publishedAt: "2026-07-28T06:00:00.000Z",
    tags: ["Jogging"],
    media: [],
    ...over,
  };
}

describe("what a record's preview says", () => {
  it("is titled by the activity, with the name after it", () => {
    // The same string site/src/activities.ts sets as document.title once the
    // record has loaded. A card and a tab disagreeing about the page's name is
    // the bug this half of the module exists to avoid.
    expect(activityMeta(record(), ENVIRONMENT).title).toBe("Morning run by the river — A Name");
  });

  it("describes it with the summary the author approved", () => {
    expect(activityMeta(record(), ENVIRONMENT).description).toBe("An easy 8 km before work.");
  });

  it("falls back to the body when there is no summary", () => {
    const meta = activityMeta(record({ summary: null }), ENVIRONMENT);

    expect(meta.description).toBe("Cool air, quiet paths, and a good pace.");
  });

  /** A card with a blank line through the middle of it is what this prevents. */
  it("flattens the paragraphs a note was written in", () => {
    const meta = activityMeta(
      record({ summary: null, body: "First light.\n\nThen the bridge.\nThen home." }),
      ENVIRONMENT,
    );

    expect(meta.description).toBe("First light. Then the bridge. Then home.");
  });

  it("cuts a long note between words rather than through one", () => {
    // Forty words, comfortably past the allowance, so the cut has to land
    // somewhere in the middle of the sentence.
    const long = Array(40).fill("running along the river").join(" ");
    const meta = activityMeta(record({ summary: long }), ENVIRONMENT);

    expect(meta.description.length).toBeLessThanOrEqual(201);
    expect(meta.description.endsWith("…")).toBe(true);
    // A whole word before the ellipsis, and no space stranded in front of it.
    expect(meta.description).not.toMatch(/\s…$/);
    expect(long.startsWith(meta.description.slice(0, -1))).toBe(true);
  });

  it("leaves a description that already fits exactly as written", () => {
    expect(activityMeta(record(), ENVIRONMENT).description).not.toContain("…");
  });

  it("says nothing rather than something empty when a record has no prose", () => {
    expect(activityMeta(record({ summary: null, body: null }), ENVIRONMENT).description).toBe("");
  });

  it("points at the page the link already names", () => {
    expect(activityMeta(record(), ENVIRONMENT).url).toBe(
      "https://site.example/activities/?v=morning-run-by-the-river",
    );
  });
});

describe("the picture the card leads with", () => {
  /**
   * `src` is the widest WebP the media pipeline built and `thumbnail` the
   * narrowest. A preview card wants the big one; the thumbnail is for a list.
   */
  it("is the photo at full size, not its thumbnail", () => {
    const meta = activityMeta(
      record({
        media: [
          {
            type: "image",
            src: "https://media.example/media/activity-a/photo-1600.webp",
            thumbnail: "https://media.example/media/activity-a/photo-400.webp",
            alt: null,
            caption: null,
          },
        ],
      }),
      ENVIRONMENT,
    );

    expect(meta.image).toBe("https://media.example/media/activity-a/photo-1600.webp");
  });

  /** A video has no still of its own; the poster is the frame it shows before play. */
  it("is a video's poster when the activity is a clip", () => {
    const meta = activityMeta(
      record({
        media: [
          {
            type: "video",
            src: "https://media.example/media/activity-a/clip.mp4",
            poster: "https://media.example/media/activity-a/clip-poster-1600.webp",
            alt: null,
            caption: null,
          },
        ],
      }),
      ENVIRONMENT,
    );

    expect(meta.image).toBe("https://media.example/media/activity-a/clip-poster-1600.webp");
  });

  it("falls back to the portrait for a note with no media", () => {
    expect(activityMeta(record(), ENVIRONMENT).image).toBe(
      "https://media.example/media/profile/hero-800.webp",
    );
  });

  /**
   * A deployment with no media bucket has no picture to offer, and a tag built
   * from an empty base would point at a path on the site itself. The rule
   * site/src/head.ts already follows for the same tag.
   */
  it("is dropped entirely when the deployment has no media bucket", () => {
    expect(activityMeta(record(), { ...ENVIRONMENT, mediaBaseUrl: "" }).image).toBeNull();
    expect(metaTags(activityMeta(record(), { ...ENVIRONMENT, mediaBaseUrl: "" })).join("\n")).not.toContain("og:image");
  });
});

describe("the tags themselves", () => {
  const tags = metaTags(activityMeta(record(), ENVIRONMENT)).join("\n");

  it("calls the page an article rather than a profile", () => {
    // The build says `profile`, which is the person. This page is one dated
    // entry by her.
    expect(tags).toContain('<meta property="og:type" content="article">');
  });

  it("carries the title, the description and the image", () => {
    expect(tags).toContain('<meta property="og:title" content="Morning run by the river — A Name">');
    expect(tags).toContain('<meta property="og:description" content="An easy 8 km before work.">');
    expect(tags).toContain('<meta property="og:image" content="https://media.example/media/profile/hero-800.webp">');
  });

  it("names the activity's own URL, canonically and for the card", () => {
    expect(tags).toContain('<meta property="og:url" content="https://site.example/activities/?v=morning-run-by-the-river">');
    expect(tags).toContain('<link rel="canonical" href="https://site.example/activities/?v=morning-run-by-the-river">');
  });

  /** Prose contains the characters that end an attribute, and titles are prose. */
  it("escapes a title that would otherwise break out of its attribute", () => {
    const escaped = metaTags(activityMeta(record({ title: 'She said "hello" & <waved>' }), ENVIRONMENT)).join("\n");

    expect(escaped).toContain('content="She said &quot;hello&quot; &amp; &lt;waved&gt; — A Name"');
  });

  it("escapes the ampersand first, so an escape is not escaped twice", () => {
    expect(escape("&lt;")).toBe("&amp;lt;");
  });
});

describe("the page as it is served", () => {
  const rewritten = withActivityMeta(PAGE, activityMeta(record(), ENVIRONMENT));

  it("is titled by the activity", () => {
    expect(rewritten).toContain("<title>Morning run by the river — A Name</title>");
    expect(rewritten).not.toContain("<title>Recent Activities — A Name</title>");
  });

  /**
   * The build's set is removed rather than added to. Two og:titles in one
   * document leaves the crawler to pick, and it does not always pick the last.
   */
  it("carries exactly one of each tag it replaces", () => {
    for (const tag of ["og:title", "og:description", "og:image", "og:type", "og:url", 'name="description"', "twitter:card"]) {
      expect(rewritten.split(tag)).toHaveLength(2);
    }
  });

  it("says nothing about the feed any more", () => {
    expect(rewritten).not.toContain("Everything I have published");
    expect(rewritten).not.toContain('content="profile"');
  });

  /** Everything that is not social metadata is the site's, and is left alone. */
  it("leaves the scripts, the stylesheet and the icons exactly as they were", () => {
    expect(rewritten).toContain('<script type="module" crossorigin src="/assets/activities-xcocYKDW.js"></script>');
    expect(rewritten).toContain('<link rel="stylesheet" crossorigin href="/assets/shell-Cz3lXKHx.css">');
    expect(rewritten).toContain('<link rel="icon" type="image/png" sizes="32x32" href="https://media.example/media/profile/favicon-32.png">');
    expect(rewritten).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />');
    expect(rewritten).toContain('<div id="app"></div>');
  });

  /**
   * Half a rewrite is worse than none: the visitor would get a page with the
   * wrong tags and broken markup. A page this does not recognise is a page it
   * does not touch.
   */
  it("returns a page it does not recognise untouched", () => {
    const foreign = "<html><body>not the activities page</body></html>";

    expect(withActivityMeta(foreign, activityMeta(record(), ENVIRONMENT))).toBe(foreign);
  });

  it("returns a page with a title but no head close untouched", () => {
    const truncated = "<html><head><title>Recent Activities</title>";

    expect(withActivityMeta(truncated, activityMeta(record(), ENVIRONMENT))).toBe(truncated);
  });
});
