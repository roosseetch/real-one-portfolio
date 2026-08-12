import { describe, expect, it } from "vitest";

import type { PublicRecord } from "../content/records";
import { composePost } from "./compose";

const SITE = "https://site.example";

function record(overrides: Partial<PublicRecord> = {}): PublicRecord {
  return {
    id: "k3m9qq2vabcd1234",
    title: "Morning run by the river",
    summary: "An easy 8 km before work.",
    body: "Cool air, quiet paths, and a good pace.",
    eventDate: "2026-07-28",
    publishedAt: "2026-07-28T06:10:00.000Z",
    tags: ["Jogging"],
    media: [],
    ...overrides,
  };
}

describe("composePost", () => {
  it("puts the title, the words and the link in the post", () => {
    const post = composePost(SITE, record());

    expect(post.preview).toContain("Morning run by the river");
    expect(post.preview).toContain("An easy 8 km before work.");
    expect(post.preview).toContain("Cool air, quiet paths, and a good pace.");
    expect(post.preview).toContain("https://site.example/activities/?v=morning-run-by-the-river");
    expect(post.url).toBe("https://site.example/activities/?v=morning-run-by-the-river");
  });

  it("turns tags into single-word hashtags", () => {
    const post = composePost(SITE, record({ tags: ["Study start-up", "PMP"] }));
    expect(post.preview).toContain("#Studystartup #PMP");
  });

  it("skips a tag with nothing hashtaggable in it rather than emitting a bare #", () => {
    const post = composePost(SITE, record({ tags: ["—", "PMP"] }));
    expect(post.preview).toContain("#PMP");
    expect(post.preview).not.toContain("# ");
  });

  it("omits the sections a record does not have", () => {
    const post = composePost(SITE, record({ summary: null, body: null, tags: [] }));
    expect(post.preview).toBe(
      "Morning run by the river\n\nhttps://site.example/activities/?v=morning-run-by-the-river",
    );
  });

  describe("escaping", () => {
    // An unescaped reserved character does not degrade the post, it fails it:
    // LinkedIn answers 422 and nothing is published.
    it("escapes every character LinkedIn's little-text fields reserve", () => {
      const post = composePost(SITE, record({ summary: "8 km (easy) @ 5:30/km ~ #done", body: null }));
      expect(post.commentary).toContain("8 km \\(easy\\) \\@ 5:30/km \\~ \\#done");
    });

    it("escapes a backslash before it can escape something else", () => {
      const post = composePost(SITE, record({ summary: "a\\(b", body: null }));
      expect(post.commentary).toContain("a\\\\\\(b");
    });

    it("shows the author what LinkedIn will render, not the escapes", () => {
      const post = composePost(SITE, record({ summary: "8 km (easy) @ 5:30/km", body: null }));
      expect(post.preview).toContain("8 km (easy) @ 5:30/km");
      expect(post.preview).not.toContain("\\");
    });

    it("leaves the link unescaped so it stays a link", () => {
      const post = composePost(SITE, record());
      expect(post.commentary.endsWith("https://site.example/activities/?v=morning-run-by-the-river")).toBe(
        true,
      );
    });
  });

  describe("truncation", () => {
    it("stays inside LinkedIn's ceiling", () => {
      const post = composePost(SITE, record({ body: "word ".repeat(1200) }));
      expect(post.commentary.length).toBeLessThanOrEqual(3000);
    });

    // The link is the point of the post. Reserving its room before a single
    // word is placed is what guarantees it is never what gets cut.
    it("keeps the whole link when the prose has to give way", () => {
      const post = composePost(SITE, record({ body: "word ".repeat(1200) }));
      expect(post.commentary.endsWith("https://site.example/activities/?v=morning-run-by-the-river")).toBe(
        true,
      );
      expect(post.commentary).toContain("…");
    });

    it("counts the escapes, not the original, against the ceiling", () => {
      // Every character here becomes two once escaped, so measuring the input
      // would let a post through at roughly twice the limit.
      const post = composePost(SITE, record({ summary: null, body: "(".repeat(2500) }));
      expect(post.commentary.length).toBeLessThanOrEqual(3000);
    });

    it("never leaves a dangling backslash where the cut landed", () => {
      const post = composePost(SITE, record({ summary: null, body: "(".repeat(2500) }));
      const prose = post.commentary.slice(0, post.commentary.indexOf("…"));
      const trailing = /\\*$/.exec(prose)?.[0].length ?? 0;
      expect(trailing % 2).toBe(0);
    });

    it("cuts at a word boundary rather than mid-word", () => {
      const post = composePost(SITE, record({ body: "elephant ".repeat(400) }));
      const cutAt = post.commentary.indexOf("…");
      expect(post.commentary.slice(cutAt - 8, cutAt)).toBe("elephant");
    });

    it("leaves a post that already fits exactly as it is", () => {
      const post = composePost(SITE, record());
      expect(post.commentary).not.toContain("…");
    });
  });

  describe("the article card", () => {
    it("names the record rather than leaving LinkedIn to crawl the feed page", () => {
      const post = composePost(SITE, record());
      expect(post.title).toBe("Morning run by the river");
      expect(post.description).toBe("An easy 8 km before work.");
    });

    it("falls back to the body when there is no summary", () => {
      const post = composePost(SITE, record({ summary: null }));
      expect(post.description).toBe("Cool air, quiet paths, and a good pace.");
    });

    it("is empty rather than wrong when the record has neither", () => {
      const post = composePost(SITE, record({ summary: null, body: null }));
      expect(post.description).toBe("");
    });
  });
});
