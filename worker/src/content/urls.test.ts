import { describe, expect, it } from "vitest";

import { activitySlug, activityUrl, linkedinActivityUrl } from "./urls";

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

/**
 * The link in a LinkedIn post is the one case where the referrer cannot be
 * relied on — see the note on linkedinActivityUrl — so these assert the exact
 * parameter names. They are not decoration: Amplitude attributes on `utm_source`
 * and `utm_medium` spelled that way and no other, and a rename here is a silent
 * return to LinkedIn traffic being counted as direct.
 */
describe("linkedinActivityUrl", () => {
  it("marks the visit as LinkedIn's, and the campaign as this record", () => {
    expect(linkedinActivityUrl("https://site.example", { id: "abc", title: "Morning run" })).toBe(
      "https://site.example/activities/?v=morning-run&utm_source=linkedin&utm_medium=social&utm_campaign=morning-run",
    );
  });

  it("still addresses the record the untagged link does", () => {
    const record = { id: "abc", title: "Ballet — first pointe" };
    const tagged = new URL(linkedinActivityUrl("https://site.example", record));
    const plain = new URL(activityUrl("https://site.example", record));

    expect(tagged.origin + tagged.pathname).toBe(plain.origin + plain.pathname);
    expect(tagged.searchParams.get("v")).toBe(plain.searchParams.get("v"));
  });

  it("works under a subpath", () => {
    const url = new URL(linkedinActivityUrl("https://pages.example/repo", { id: "abc", title: "Morning run" }));

    expect(url.pathname).toBe("/repo/activities/");
    expect(url.searchParams.get("utm_source")).toBe("linkedin");
  });

  // The slug falls back to the id for a title with nothing ASCII in it, and the
  // campaign has to follow it rather than becoming empty — an empty utm_campaign
  // is a campaign Amplitude cannot tell from any other post's.
  it("names the campaign after the id when the title does not slug", () => {
    const url = new URL(linkedinActivityUrl("https://site.example", { id: "k3m9qq2v", title: "🎉🎉" }));

    expect(url.searchParams.get("utm_campaign")).toBe("k3m9qq2v");
    expect(url.searchParams.get("v")).toBe("k3m9qq2v");
  });
});
