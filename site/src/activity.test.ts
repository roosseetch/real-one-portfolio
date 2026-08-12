/**
 * The parts every view of the feed shares, and the landing page's teaser.
 *
 * The loader's own states — merging chunks, surviving a broken one, an
 * unreadable bucket — are exercised in activities.test.ts, against the page that
 * shows every record. This file is about what the teaser shows instead of all of
 * them, and about the URL that names a single activity, which both pages build.
 *
 * No network: every response is stubbed by the shared bucket helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityHref, activitySlug, renderActivityPreview, selectRecords } from "./activity";
import { bucketOf, loaded, record, serve } from "./test-support/activity-bucket";

function mount(): HTMLElement {
  const section = document.createElement("section");
  document.body.append(section);
  renderActivityPreview(section, "Recent Activities");
  return section;
}

const titles = (section: HTMLElement) =>
  [...section.querySelectorAll(".activity-card h3")].map((node) => node.textContent);

const noteText = (section: HTMLElement) => section.querySelector(".activity-note")?.textContent;

const dated = (title: string, day: string) => record(title, { publishedAt: `2026-08-${day}T09:00:00.000Z` });

beforeEach(() => {
  document.body.replaceChildren();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the slug an activity is addressed by", () => {
  const slugOf = (title: string, id = "fallback-id") => activitySlug({ id, title });

  it("is the title, lowercased and hyphenated", () => {
    expect(slugOf("Morning Run by the River")).toBe("morning-run-by-the-river");
  });

  it("drops punctuation rather than encoding it", () => {
    expect(slugOf("Coffee, at 7 a.m. — finally!")).toBe("coffee-at-7-a-m-finally");
  });

  it("folds accents to the letters they are built from", () => {
    expect(slugOf("Café by the Seine")).toBe("cafe-by-the-seine");
  });

  it("leaves no dash hanging off either end", () => {
    expect(slugOf("  ...Tired.  ")).toBe("tired");
  });

  it("stays short enough to read in a shared link", () => {
    expect(slugOf("word ".repeat(40)).length).toBeLessThanOrEqual(60);
  });

  it("falls back to the id when a title has nothing a URL can carry", () => {
    // An empty ?v= names nothing at all, so an emoji-only title has to be
    // addressed by something else.
    expect(slugOf("🏃‍♀️🌅", "k3m9x2qp")).toBe("k3m9x2qp");
  });
});

describe("what a ?v= value selects", () => {
  const records = [record("Morning run"), record("An afternoon at the museum")];

  it("finds the record whose title slugs to it", () => {
    expect(selectRecords(records, "morning-run").map((r) => r.title)).toEqual(["Morning run"]);
  });

  it("finds a record by its id too, so a link can always be unambiguous", () => {
    expect(selectRecords(records, "id-Morning run").map((r) => r.title)).toEqual(["Morning run"]);
  });

  it("returns every record sharing a slug rather than picking one of them", () => {
    const twice = [record("Morning run", { id: "one" }), record("Morning run", { id: "two" })];
    expect(selectRecords(twice, "morning-run").map((r) => r.id)).toEqual(["one", "two"]);
  });

  it("prefers an exact id to a title that happens to slug the same", () => {
    const confusing = [record("x", { id: "abc" }), record("ABC", { id: "def" })];
    expect(selectRecords(confusing, "abc").map((r) => r.id)).toEqual(["abc"]);
  });

  it("returns nothing for a value naming nothing", () => {
    expect(selectRecords(records, "never-happened")).toEqual([]);
  });

  it("builds a link the page can read back", () => {
    expect(activityHref(record("Morning run"))).toBe("/activities/?v=morning-run");
  });
});

describe("the landing page's teaser", () => {
  it("shows the two most recent and not the rest", async () => {
    serve(bucketOf([dated("oldest", "01"), dated("middle", "02")], [dated("newest", "03")]));
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["newest", "middle"]);
  });

  it("shows what there is when there are fewer than two", async () => {
    serve(bucketOf([record("only one")]));
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["only one"]);
  });

  it("offers no sort control, which the page that has every record has instead", async () => {
    serve(bucketOf([dated("a", "01"), dated("b", "02"), dated("c", "03")]));
    const section = mount();
    await loaded(section);

    expect(section.querySelector(".activity-sort")).toBeNull();
  });

  it("lays the cards out side by side", async () => {
    serve(bucketOf([record("a"), record("b")]));
    const section = mount();
    await loaded(section);

    expect(section.querySelector(".activity-list")?.className).toContain("activity-preview");
  });

  it("links each card to that activity's own page", async () => {
    serve(bucketOf([record("Morning run")]));
    const section = mount();
    await loaded(section);

    const link = section.querySelector(".activity-card-link") as HTMLAnchorElement;
    expect(link.textContent).toBe("Morning run");
    expect(link.getAttribute("href")).toBe("/activities/?v=morning-run");
  });

  it("leads on to the whole list", async () => {
    serve(bucketOf([record("a")]));
    const section = mount();
    await loaded(section);

    const more = section.querySelector(".activity-more") as HTMLAnchorElement;
    expect(more.textContent).toBe("See all activities");
    expect(more.getAttribute("href")).toBe("/activities/");
  });

  it("shows placeholders that announce themselves as busy while loading", () => {
    serve(bucketOf([record("one")]));
    const skeleton = mount().querySelector(".activity-skeleton");

    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("role")).toBe("status");
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
  });

  it("says nothing has been published rather than showing an empty heading", async () => {
    serve(bucketOf());
    const section = mount();
    await loaded(section);

    expect(noteText(section)).toBe("No activities published yet.");
    expect(section.querySelector(".activity-more")).toBeNull();
  });

  it("promises the feed instead of failing at a URL built from undefined", async () => {
    // The state every deployment starts in: the site is on Pages before the
    // Cloudflare buckets exist.
    vi.stubEnv("VITE_CONTENT_BASE_URL", "");
    vi.resetModules();
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    const { renderActivityPreview: render } = await import("./activity");
    const section = document.createElement("section");
    document.body.append(section);
    render(section, "Recent Activities");

    expect(noteText(section)).toBe("Recent activities will appear here soon.");
    expect(fetchStub).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
