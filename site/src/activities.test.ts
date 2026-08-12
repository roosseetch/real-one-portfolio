/**
 * The /activities page: the whole feed, and one activity on its own.
 *
 * Everything here goes through renderActivities, because the states worth
 * testing are what a visitor ends up looking at: a chunk that will not parse has
 * to leave the rest of the feed standing, a bucket that is not there yet has to
 * leave a sentence rather than an empty heading, and a link to an activity that
 * has since been removed has to say so rather than show an empty page.
 *
 * The query string is passed in rather than set on location, so each view is
 * rendered without the test having to be at that URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderActivitiesSection } from "./activities";
import { facts } from "./profile";
import { CONTENT_BASE, bucketOf, loaded, record, serve } from "./test-support/activity-bucket";

function mount(search = "", track?: (eventType: string, properties?: Record<string, unknown>) => void): HTMLElement {
  const section = renderActivitiesSection(search, { track });
  document.body.append(section);
  return section;
}

const titles = (section: HTMLElement) =>
  [...section.querySelectorAll(".activity-card h2, .activity-card h3")].map((node) => node.textContent);

const noteText = (section: HTMLElement) => section.querySelector(".activity-note")?.textContent;

const sortToggle = (section: HTMLElement) => section.querySelector(".activity-sort") as HTMLButtonElement;

beforeEach(() => {
  document.body.replaceChildren();
  document.title = "";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("one chunk", () => {
  it("renders every record it holds", async () => {
    serve(bucketOf([record("first"), record("second")]));
    const section = mount();
    await loaded(section);

    // Newest first is the default, and a chunk stores records in the order
    // they were published, so a chunk comes back reversed.
    expect(titles(section)).toEqual(["second", "first"]);
  });

  it("reads the manifest once and the chunk once", async () => {
    const fetchStub = serve(bucketOf([record("first")]));
    await loaded(mount());

    expect(fetchStub.mock.calls.map((call) => String(call[0]))).toEqual([
      `${CONTENT_BASE}/content/manifest.json`,
      `${CONTENT_BASE}/content/records-chunk0.json`,
    ]);
  });

  it("drops entries missing the fields a card is built from", async () => {
    serve(bucketOf([record("usable"), { id: "no-title" }, { title: "no id" }, null, "not an object"]));
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["usable"]);
  });
});

describe("many chunks", () => {
  it("merges them into one feed", async () => {
    serve(bucketOf([record("a"), record("b")], [record("c")], [record("d")]));
    const section = mount();
    await loaded(section);

    // Chunks are loaded oldest first and shown newest first.
    expect(titles(section)).toEqual(["d", "c", "b", "a"]);
  });

  it("keeps going when one chunk is not an array", async () => {
    const objects = bucketOf([record("a")], [record("b")]);
    objects["content/records-chunk1.json"] = { not: "an array" };
    serve(objects);
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["a"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("keeps going when one chunk is missing from the bucket", async () => {
    const objects = bucketOf([record("a")], [record("b")]);
    delete objects["content/records-chunk0.json"];
    serve(objects);
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["b"]);
  });
});

describe("an empty feed", () => {
  it("says nothing has been published rather than showing an empty heading", async () => {
    serve(bucketOf());
    const section = mount();
    await loaded(section);

    expect(noteText(section)).toBe("No activities published yet.");
    expect(titles(section)).toEqual([]);
  });

  it("offers no sort control, which would sort nothing", async () => {
    serve(bucketOf());
    const section = mount();
    await loaded(section);

    expect(sortToggle(section)).toBeNull();
  });

  it("treats a manifest with chunks that are all empty as empty too", async () => {
    serve(bucketOf([], []));
    const section = mount();
    await loaded(section);

    expect(noteText(section)).toBe("No activities published yet.");
  });
});

describe("a bucket that cannot be read", () => {
  it("says the feed is unavailable when the manifest is missing", async () => {
    serve({});
    const section = mount();
    await loaded(section);

    expect(noteText(section)).toBe("Activities are unavailable right now. Please check back later.");
  });

  it("says the same when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const section = mount();
    await loaded(section);

    expect(noteText(section)).toBe("Activities are unavailable right now. Please check back later.");
  });

  it("takes the placeholders down either way, rather than leaving them spinning", async () => {
    serve({});
    const section = mount();
    await loaded(section);

    expect(section.querySelector(".activity-skeleton")).toBeNull();
  });

  it("says so on a link to one activity too", async () => {
    serve({});
    const section = mount("?v=morning-run");
    await loaded(section);

    expect(noteText(section)).toBe("Activities are unavailable right now. Please check back later.");
  });
});

/* Publication order, both ways round. The feed sorts on publishedAt rather
   than on the date the author's note happened to mention, so these fix the
   behaviour a records file cannot express on its own. */
describe("sort order", () => {
  const dated = () =>
    bucketOf(
      [record("oldest", { publishedAt: "2026-08-01T09:00:00.000Z" })],
      [
        record("newest", { publishedAt: "2026-08-03T09:00:00.000Z" }),
        record("middle", { publishedAt: "2026-08-02T09:00:00.000Z" }),
      ],
    );

  it("opens newest first", async () => {
    serve(dated());
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["newest", "middle", "oldest"]);
  });

  it("reverses to oldest first when the control is pressed", async () => {
    serve(dated());
    const section = mount();
    await loaded(section);

    const toggle = sortToggle(section);
    expect(toggle.textContent).toBe("Oldest first");
    toggle.click();

    expect(titles(section)).toEqual(["oldest", "middle", "newest"]);
    expect(toggle.textContent).toBe("Newest first");
  });

  it("goes back again on a second press", async () => {
    serve(dated());
    const section = mount();
    await loaded(section);

    const toggle = sortToggle(section);
    toggle.click();
    toggle.click();

    expect(titles(section)).toEqual(["newest", "middle", "oldest"]);
    expect(toggle.textContent).toBe("Oldest first");
  });

  it("ignores the date the note mentioned", async () => {
    serve(
      bucketOf([
        record("published first", { publishedAt: "2026-08-01T09:00:00.000Z", eventDate: "2026-01-01" }),
        record("published second", { publishedAt: "2026-08-02T09:00:00.000Z", eventDate: "1999-01-01" }),
      ]),
    );
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["published second", "published first"]);
  });

  it("treats a record published before the field existed as the oldest there is", async () => {
    serve(
      bucketOf([
        record("undated"),
        record("stamped", { publishedAt: "2020-01-01T00:00:00.000Z" }),
      ]),
    );
    const section = mount();
    await loaded(section);

    expect(titles(section)).toEqual(["stamped", "undated"]);
  });

  it("leaves records sharing a timestamp in the order they were published", async () => {
    const at = "2026-08-01T09:00:00.000Z";
    serve(bucketOf([record("first", { publishedAt: at }), record("second", { publishedAt: at })]));
    const section = mount();
    await loaded(section);

    // Newest first, so the later of two simultaneous records comes first; the
    // reversal has to reverse the tie as well.
    expect(titles(section)).toEqual(["second", "first"]);
    sortToggle(section).click();
    expect(titles(section)).toEqual(["first", "second"]);
  });
});

describe("what a record renders as", () => {
  it("shows the text the record carries and nothing it does not", async () => {
    serve(
      bucketOf([
        record("with everything", {
          summary: "A short line.",
          body: "The longer text.",
          eventDate: "2026-07-30",
          tags: ["Art", "Photography"],
        }),
      ]),
    );
    const section = mount();
    await loaded(section);

    const card = section.querySelector(".activity-card") as HTMLElement;
    expect(card.querySelector(".activity-summary")?.textContent).toBe("A short line.");
    expect(card.querySelector(".activity-body")?.textContent).toBe("The longer text.");
    expect(card.querySelector(".activity-date")?.textContent).toBe("2026-07-30");
    expect([...card.querySelectorAll(".activity-tag")].map((tag) => tag.textContent)).toEqual([
      "Art",
      "Photography",
    ]);
  });

  it("leaves out what a record does not carry", async () => {
    serve(bucketOf([record("bare")]));
    const section = mount();
    await loaded(section);

    const card = section.querySelector(".activity-card") as HTMLElement;
    expect(card.querySelector(".activity-summary")).toBeNull();
    expect(card.querySelector(".activity-date")).toBeNull();
    expect(card.querySelector(".activity-tags")).toBeNull();
  });

  it("loads a picture lazily, from its thumbnail, with the caption beside it", async () => {
    serve(
      bucketOf([
        record("with a photo", {
          media: [
            {
              type: "image",
              src: "https://media.test/media/activity-1/full.webp",
              thumbnail: "https://media.test/media/activity-1/thumb.webp",
              alt: "A description",
              caption: "A caption",
            },
          ],
        }),
      ]),
    );
    const section = mount();
    await loaded(section);

    const img = section.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://media.test/media/activity-1/thumb.webp");
    expect(img.alt).toBe("A description");
    expect(img.loading).toBe("lazy");
    expect(section.querySelector("figcaption")?.textContent).toBe("A caption");
  });

  it("shows a video as its poster until someone presses play", async () => {
    // preload="none" without a poster is a blank box: nothing has been
    // downloaded to draw.
    serve(
      bucketOf([
        record("with a clip", {
          media: [
            {
              type: "video",
              src: "https://media.test/media/activity-1/clip.mp4",
              poster: "https://media.test/media/activity-1/poster.webp",
              alt: "A clip of something",
            },
          ],
        }),
      ]),
    );
    const section = mount();
    await loaded(section);

    const video = section.querySelector("video") as HTMLVideoElement;
    expect(video.poster).toBe("https://media.test/media/activity-1/poster.webp");
    expect(video.preload).toBe("none");
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    // A video has no alt attribute, so the same words become its accessible name.
    expect(video.getAttribute("aria-label")).toBe("A clip of something");
  });

  it("links every card in the list to that activity's own page", async () => {
    serve(bucketOf([record("Morning run")]));
    const section = mount();
    await loaded(section);

    expect((section.querySelector(".activity-card-link") as HTMLAnchorElement).getAttribute("href")).toBe(
      "/activities/?v=morning-run",
    );
  });
});

describe("one activity, by ?v=", () => {
  const feed = () =>
    bucketOf([
      record("Morning run", { body: "Cool air, quiet paths.", publishedAt: "2026-08-01T09:00:00.000Z" }),
      record("An afternoon at the museum", { publishedAt: "2026-08-02T09:00:00.000Z" }),
    ]);

  it("shows the one it names and none of the others", async () => {
    serve(feed());
    const section = mount("?v=morning-run");
    await loaded(section);

    expect(titles(section)).toEqual(["Morning run"]);
    expect(section.querySelector(".activity-body")?.textContent).toBe("Cool air, quiet paths.");
  });

  it("gives it the page's own heading level, and no link to where it already is", async () => {
    serve(feed());
    const section = mount("?v=morning-run");
    await loaded(section);

    expect(section.querySelector(".activity-card h2")?.textContent).toBe("Morning run");
    expect(section.querySelector(".activity-card-link")).toBeNull();
  });

  it("leads back to the whole list", async () => {
    serve(feed());
    const section = mount("?v=morning-run");
    await loaded(section);

    const back = section.querySelector(".activity-back") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/activities/");
  });

  it("says which activity this is, in the tab and in a bookmark", async () => {
    serve(feed());
    const section = mount("?v=morning-run");
    await loaded(section);

    expect(document.title).toBe(`Morning run — ${facts.displayName}`);
  });

  it("offers no sort control, there being one record to sort", async () => {
    serve(feed());
    const section = mount("?v=morning-run");
    await loaded(section);

    expect(sortToggle(section)).toBeNull();
  });

  it("resolves a record id as well as a slug, for a link that has to be exact", async () => {
    serve(feed());
    const section = mount("?v=id-Morning%20run");
    await loaded(section);

    expect(titles(section)).toEqual(["Morning run"]);
  });

  it("shows both when two activities are titled alike, and says so", async () => {
    serve(
      bucketOf([
        record("Morning run", { id: "one", publishedAt: "2026-08-01T09:00:00.000Z" }),
        record("Morning run", { id: "two", publishedAt: "2026-08-02T09:00:00.000Z" }),
      ]),
    );
    const section = mount("?v=morning-run");
    await loaded(section);

    expect(titles(section)).toEqual(["Morning run", "Morning run"]);
    expect(noteText(section)).toBe("2 activities share this name.");
    // The title is ambiguous, so it is not what the tab is renamed after.
    expect(document.title).toBe("");
  });

  it("says so when the link names nothing, rather than showing an empty page", async () => {
    serve(feed());
    const section = mount("?v=never-happened");
    await loaded(section);

    expect(noteText(section)).toBe(
      "That activity is not here. It may have been removed since the link was made.",
    );
    expect(titles(section)).toEqual([]);
    expect(section.querySelector(".activity-back")).not.toBeNull();
  });

  it("reports a link that names nothing, which a page-view count cannot show", async () => {
    serve(feed());
    const track = vi.fn();
    const section = mount("?v=never-happened", track);
    await loaded(section);

    expect(track).toHaveBeenCalledWith("activity_not_found", { v: "never-happened" });
  });

  it("keeps quiet when the link resolves", async () => {
    serve(feed());
    const track = vi.fn();
    const section = mount("?v=morning-run", track);
    await loaded(section);

    expect(track).not.toHaveBeenCalled();
  });
});
