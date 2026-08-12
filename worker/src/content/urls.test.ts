import { describe, expect, it } from "vitest";

import { activitySlug, activityUrl } from "./urls";

/**
 * These cases mirror site/src/activity.test.ts. The two implementations are
 * separate on purpose — separate builds, and the site's reads import.meta.env —
 * so this file is the only thing stopping one from being changed without the
 * other, which would leave the Worker handing out links the site cannot resolve.
 */
describe("activitySlug", () => {
  it("lowercases and joins words with hyphens", () => {
    expect(activitySlug({ id: "abc", title: "Morning run by the river" })).toBe(
      "morning-run-by-the-river",
    );
  });

  it("strips accents rather than dropping the letter under them", () => {
    expect(activitySlug({ id: "abc", title: "Café résumé" })).toBe("cafe-resume");
  });

  it("collapses runs of punctuation into one hyphen and trims the ends", () => {
    expect(activitySlug({ id: "abc", title: "  Ballet — first pointe!!  " })).toBe(
      "ballet-first-pointe",
    );
  });

  it("caps the length, and leaves no trailing hyphen where the cut landed", () => {
    const slug = activitySlug({ id: "abc", title: "a".repeat(40) + " " + "b".repeat(40) });
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to the id for a title with nothing ASCII in it", () => {
    expect(activitySlug({ id: "k3m9qq2v", title: "🎉🎉" })).toBe("k3m9qq2v");
  });
});

describe("activityUrl", () => {
  it("addresses the record's own page", () => {
    expect(activityUrl("https://site.example", { id: "abc", title: "Morning run" })).toBe(
      "https://site.example/activities/?v=morning-run",
    );
  });

  it("does not double the slash on a base that has one", () => {
    expect(activityUrl("https://site.example/", { id: "abc", title: "Morning run" })).toBe(
      "https://site.example/activities/?v=morning-run",
    );
  });

  // A project-pages deployment serves the site from /<repo>/ rather than the
  // root, and SITE_BASE_URL carries that path.
  it("works under a subpath", () => {
    expect(activityUrl("https://pages.example/repo", { id: "abc", title: "Morning run" })).toBe(
      "https://pages.example/repo/activities/?v=morning-run",
    );
  });
});
