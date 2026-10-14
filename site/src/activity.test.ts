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

import {
  activityHref,
  activitySlug,
  derivativeSrcset,
  renderActivityPreview,
  renderRecord,
  selectRecords,
} from "./activity";
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

/* What a card shows when it is one of many, rather than the page itself. The
   allowance is a number in the module and deliberately not repeated here: these
   fix the behaviour — cut at a word, offer the rest, leave short notes alone —
   and leave the tuning free to move. */
describe("the excerpt a listing card shows", () => {
  /** Prose of about `length` characters, in short words and no punctuation. */
  const prose = (length: number) => "word ".repeat(Math.ceil(length / 5)).slice(0, length).trim();

  const listed = (extra: Record<string, unknown>) =>
    renderRecord({ id: "rec-1", title: "A long note", ...extra }, { href: "/activities/?v=a-long-note", excerpt: true });

  const bodies = (card: HTMLElement) => [...card.querySelectorAll(".activity-body")].map((p) => p.textContent ?? "");

  const readMore = (card: HTMLElement) => card.querySelector(".activity-read-more") as HTMLAnchorElement | null;

  it("leaves a note that fits exactly as it was written", () => {
    const body = prose(250);
    const card = listed({ body });

    expect(bodies(card)).toEqual([body]);
    expect(readMore(card)).toBeNull();
  });

  it("cuts a long one between words, not through one", () => {
    const body = prose(1000);
    const shown = bodies(listed({ body }))[0];

    expect(shown.endsWith("…")).toBe(true);
    const kept = shown.slice(0, -1);
    expect(body.startsWith(kept)).toBe(true);
    // The character the note carries on with is a space, so no half word was
    // left on the card.
    expect(body[kept.length]).toBe(" ");
  });

  it("cuts it down to something card-sized", () => {
    const card = listed({ body: prose(4000) });
    const shown = bodies(card).join("").length;

    expect(shown).toBeLessThan(400);
  });

  it("drops the paragraphs that did not fit rather than squeezing them in", () => {
    const card = listed({ body: [prose(200), prose(200), prose(200)].join("\n\n") });

    expect(bodies(card).length).toBeLessThan(3);
  });

  it("counts the summary against the same allowance", () => {
    // Both are prose the visitor reads, so a card carrying a long summary and a
    // long body is as tall as one carrying only a long body.
    const card = listed({ summary: prose(200), body: prose(1000) });

    expect(card.querySelector(".activity-summary")?.textContent).toBe(prose(200));
    expect(bodies(card).join("").length).toBeLessThan(200);
  });

  it("cuts the summary too when the summary is the long part", () => {
    const shown = listed({ summary: prose(1000) }).querySelector(".activity-summary")?.textContent ?? "";

    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThan(1000);
  });

  it("offers the rest, saying which activity it opens", () => {
    const link = readMore(listed({ body: prose(1000) }));

    expect(link?.textContent).toBe("Read more");
    expect(link?.getAttribute("href")).toBe("/activities/?v=a-long-note");
    // Ten cards on a page would otherwise be ten links all reading "Read more".
    expect(link?.getAttribute("aria-label")).toBe("Read more: A long note");
  });

  it("shows the whole note on the card that is the page, however long it is", () => {
    // No href: this is the record on its own page, and there is nowhere to send
    // anyone for the rest of it.
    const body = prose(4000);
    const card = renderRecord({ id: "rec-1", title: "A long note", body }, { heading: "h1" });

    expect(bodies(card)).toEqual([body]);
    expect(readMore(card)).toBeNull();
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

  it("cuts a long note down, two cards being side by side up here", async () => {
    serve(bucketOf([record("A long one", { body: "word ".repeat(400) })]));
    const section = mount();
    await loaded(section);

    expect(section.querySelector(".activity-body")?.textContent?.endsWith("…")).toBe(true);
    expect(section.querySelector(".activity-read-more")).not.toBeNull();
  });

  it("leads on to the whole list", async () => {
    serve(bucketOf([record("a")]));
    const section = mount();
    await loaded(section);

    // Beside the section's heading, where the design puts it, rather than at
    // the foot of the two cards.
    const more = section.querySelector(".activity-head .activity-more") as HTMLAnchorElement;
    expect(more.textContent).toBe("View all activities \u2192");
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

/* The photo stack at the head of a listing card. Records vary in how much media
   they carry, and the figure has to degrade all the way down rather than being
   drawn for the three-picture case and left broken for the others. */
describe("the photo stack on a listing card", () => {
  const image = (n: number) => ({
    type: "image" as const,
    src: `https://media.test/media/activity-1/full-${n}.webp`,
    thumbnail: `https://media.test/media/activity-1/thumb-${n}.webp`,
    alt: `Picture ${n}`,
  });

  const listed = (media: unknown[]) =>
    renderRecord(
      { id: "rec-1", title: "A note", media: media as never },
      { href: "/activities/?v=a-note", excerpt: true },
    );

  const cells = (card: HTMLElement) => card.querySelectorAll(".activity-mosaic-cell");

  it("shows one large plate and two beside it", () => {
    const card = listed([image(1), image(2), image(3)]);

    expect(cells(card)).toHaveLength(3);
    expect(card.querySelector(".activity-mosaic-more")).toBeNull();
  });

  it("counts what did not fit, rather than dropping it silently", () => {
    const card = listed([image(1), image(2), image(3), image(4), image(5)]);

    expect(cells(card)).toHaveLength(3);
    expect(card.querySelector(".activity-mosaic-more")?.textContent).toBe("+2");
  });

  it("falls back to a single plate, and to no figure at all", () => {
    const one = listed([image(1)]);
    expect(cells(one)).toHaveLength(1);
    expect(one.querySelector(".activity-mosaic")?.className).toContain("is-single");

    expect(listed([]).querySelector(".activity-mosaic")).toBeNull();
  });

  /** A <video> in a 168px cell is a play button over a frame nobody has downloaded. */
  it("shows a clip as its poster", () => {
    const card = listed([
      {
        type: "video",
        src: "https://media.test/media/activity-1/clip.mp4",
        poster: "https://media.test/media/activity-1/poster.webp",
      },
    ]);

    expect(card.querySelector("img")?.getAttribute("src")).toBe(
      "https://media.test/media/activity-1/poster.webp",
    );
    expect(card.querySelector("video")).toBeNull();
  });

  /**
   * Clickable, because the design makes the whole card one target — but not a
   * third stop for a keyboard or a screen reader, which already have the title
   * and "Read more" pointing at the same page.
   */
  it("is clickable without becoming a third link to the same page", () => {
    const link = listed([image(1)]).querySelector<HTMLAnchorElement>(".activity-mosaic-link");

    expect(link?.getAttribute("href")).toBe("/activities/?v=a-note");
    expect(link?.tabIndex).toBe(-1);
    expect(link?.getAttribute("aria-hidden")).toBe("true");
  });

  /** The card's title and excerpt say what the record is; three alt texts on the way past do not. */
  it("leaves the pictures undescribed, since the card already describes the record", () => {
    const card = listed([image(1), image(2)]);

    expect([...card.querySelectorAll("img")].every((img) => img.alt === "")).toBe(true);
  });

  /* The same poster rule as the filmstrip's, for the same reason: a clip in a
     mosaic shows its poster, and posters are WebP only. */
  it("offers a clip's cell no AVIF", () => {
    const cell = listed([
      {
        type: "video",
        src: "https://media.test/media/activity-1/c.mp4",
        poster: "https://media.test/media/activity-1/c-poster-1600.webp",
      },
    ]).querySelector(".activity-mosaic-cell") as HTMLElement;

    expect(cell.querySelector("img")?.getAttribute("src")).toContain("c-poster-1600.webp");
    expect(cell.querySelector("source")).toBeNull();
  });

  /* A third of a 60rem card on the listing page, where the 320px thumbnail is
     a blur on a 2x screen: the small cells get the ladder too, in both formats,
     sized for the column they sit in. */
  it("offers each small mosaic cell the ladder, in both formats", () => {
    const ladder = (n: number) => ({
      ...image(n),
      src: `https://media.test/media/activity-1/s${n}-1200.webp`,
      thumbnail: `https://media.test/media/activity-1/s${n}-320.webp`,
    });
    const cells = [...listed([ladder(1), ladder(2), ladder(3)]).querySelectorAll(".activity-mosaic-stack .activity-mosaic-cell")];

    expect(cells.length).toBe(2);
    for (const [index, cell] of cells.entries()) {
      const img = cell.querySelector("img") as HTMLImageElement;
      const source = cell.querySelector("source") as HTMLSourceElement;
      const n = index + 2;
      expect(img.getAttribute("srcset")).toBe(
        `https://media.test/media/activity-1/s${n}-320.webp 320w, https://media.test/media/activity-1/s${n}-800.webp 800w, https://media.test/media/activity-1/s${n}-1200.webp 1200w`,
      );
      expect(img.getAttribute("sizes")).toBe("(max-width: 48rem) 5.5rem, 25rem");
      expect(source.type).toBe("image/avif");
      expect(source.getAttribute("srcset")).toContain(`s${n}-1200.avif 1200w`);
      expect(source.getAttribute("sizes")).toBe(img.getAttribute("sizes"));
      expect(img.getAttribute("loading")).toBe("lazy");
    }
  });

  it("sizes the large plate to the two thirds the stack leaves it", () => {
    const img = listed([image(1), image(2)]).querySelector(".activity-mosaic > .activity-mosaic-cell img");
    expect(img?.getAttribute("sizes")).toBe("(max-width: 48rem) 100vw, 50rem");
  });

  /** The large plate spans the card, and 320 pixels across it is a blur. */
  it("offers the large plate the whole ladder, in both formats", () => {
    const plate = listed([
      { ...image(1), src: "https://media.test/media/activity-1/p-1024.webp", thumbnail: "https://media.test/media/activity-1/p-320.webp" },
    ]).querySelector(".activity-mosaic-cell") as HTMLElement;

    expect(plate.querySelector("img")?.getAttribute("srcset")).toBe(
      "https://media.test/media/activity-1/p-320.webp 320w, https://media.test/media/activity-1/p-800.webp 800w, https://media.test/media/activity-1/p-1024.webp 1024w",
    );
    expect(plate.querySelector("source")?.getAttribute("srcset")).toContain("p-1024.avif 1024w");
    // A lone picture spans the listing page's whole card.
    expect(plate.querySelector("img")?.getAttribute("sizes")).toBe("(max-width: 48rem) 100vw, 75rem");
    expect(plate.querySelector("source")?.getAttribute("sizes")).toBe(plate.querySelector("img")?.getAttribute("sizes"));
  });

  /** The page that shows one record shows every image in full, not a stack of three. */
  it("does not appear on the page that shows the record itself", () => {
    const single = renderRecord({ id: "rec-1", title: "A note", media: [image(1)] as never }, { heading: "h1" });

    expect(single.querySelector(".activity-mosaic")).toBeNull();
    expect(single.querySelector(".media-carousel")).not.toBeNull();
  });
});

/* The carousel on a record's own page. Scroll position is the source of truth
   for where it is, and happy-dom has no layout — every offset is zero — so what
   is exercised here is the structure and the initial state. Paging itself is a
   browser check (the plan's step 4), like every other scroll-snap behaviour. */
describe("the media carousel", () => {
  const image = (n: number, extra: Record<string, unknown> = {}) => ({
    type: "image" as const,
    src: `https://media.test/media/activity-1/full-${n}.webp`,
    thumbnail: `https://media.test/media/activity-1/thumb-${n}.webp`,
    alt: `Picture ${n}`,
    ...extra,
  });

  const single = (media: unknown[]) =>
    renderRecord({ id: "rec-1", title: "A note", media: media as never }, { heading: "h1" });

  it("shows every item once in the track and once in the strip", () => {
    const card = single([image(1), image(2), image(3), image(4), image(5)]);

    expect(card.querySelectorAll(".carousel-slide")).toHaveLength(5);
    expect(card.querySelectorAll(".carousel-thumb")).toHaveLength(5);
  });

  /** Padded, so the counter does not change width as it counts. */
  it("says where in the set the reader is", () => {
    const counter = single([image(1), image(2), image(3)]).querySelector(".carousel-counter");

    expect(counter?.textContent).toBe("1 / 3");
    expect(counter?.getAttribute("aria-live")).toBe("polite");
  });

  it("marks the item the strip is showing", () => {
    const thumbs = [...single([image(1), image(2)]).querySelectorAll(".carousel-thumb")];

    expect(thumbs[0].getAttribute("aria-current")).toBe("true");
    expect(thumbs[1].getAttribute("aria-current")).toBeNull();
  });

  /** Nothing before the first item, so the arrow says so rather than doing nothing. */
  it("disables the arrow that has nowhere to go", () => {
    const arrows = [...single([image(1), image(2)]).querySelectorAll<HTMLButtonElement>(".carousel-arrow")];

    expect(arrows.map((arrow) => arrow.getAttribute("aria-label"))).toEqual(["Previous", "Next"]);
    expect(arrows[0].disabled).toBe(true);
    expect(arrows[1].disabled).toBe(false);
  });

  /** One picture is not a set, so there is nothing to navigate and no chrome for it. */
  it("drops the controls for a record carrying one item", () => {
    const card = single([image(1, { caption: "Just the one" })]);

    expect(card.querySelectorAll(".carousel-slide")).toHaveLength(1);
    expect(card.querySelector(".carousel-bar")).toBeNull();
    expect(card.querySelector(".carousel-strip")).toBeNull();
    expect(card.querySelector(".carousel-caption")?.textContent).toBe("Just the one");
  });

  it("renders nothing at all for a record carrying none", () => {
    expect(single([]).querySelector(".media-carousel")).toBeNull();
  });

  /** An item with no caption must not leave an empty line under the plate. */
  it("hides the caption a record does not have", () => {
    const caption = single([image(1)]).querySelector<HTMLElement>(".carousel-caption");

    expect(caption?.hidden).toBe(true);
  });

  it("keeps a clip a clip, poster and all", () => {
    const card = single([
      image(1),
      {
        type: "video",
        src: "https://media.test/media/activity-1/clip.mp4",
        poster: "https://media.test/media/activity-1/poster.webp",
        alt: "A clip of something",
      },
    ]);
    const video = card.querySelector("video") as HTMLVideoElement;

    expect(video.poster).toBe("https://media.test/media/activity-1/poster.webp");
    expect(video.preload).toBe("none");
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.getAttribute("aria-label")).toBe("A clip of something");
    // And its thumbnail in the strip is the poster, not a second <video>.
    expect(card.querySelectorAll("video")).toHaveLength(1);
  });

  /** The track scrolls, so it has to be a focus stop with a name of its own. */
  it("lets a keyboard reach the track", () => {
    const track = single([image(1), image(2)]).querySelector<HTMLElement>(".carousel-track");

    expect(track?.tabIndex).toBe(0);
    expect(track?.getAttribute("aria-label")).toContain("arrow keys");
  });
});

describe("the derivatives a picture's URL implies", () => {
  const base = "https://media.test/media/activity-1/abc";

  /* The sanitiser clamps every requested width to the source and drops what
     that leaves duplicated, so the ladder below the widest is exactly what it
     wrote — no guessing, and no width that would 404. */
  it("keeps only the ladder widths below the widest one", () => {
    expect(derivativeSrcset(`${base}-960.webp`)).toBe(
      `${base}-320.webp 320w, ${base}-800.webp 800w, ${base}-960.webp 960w`,
    );
  });

  it("claims no 1200 or 1600 that the source was too small to produce", () => {
    const srcset = derivativeSrcset(`${base}-960.webp`);

    expect(srcset).not.toContain("1200w");
    expect(srcset).not.toContain("1600w");
  });

  it("lists the full ladder when the source reached the top of it", () => {
    expect(derivativeSrcset(`${base}-1600.webp`)).toBe(
      `${base}-320.webp 320w, ${base}-800.webp 800w, ${base}-1200.webp 1200w, ${base}-1600.webp 1600w`,
    );
  });

  /* A width that is itself a ladder entry must appear once, as the widest, and
     not a second time from the filter below it. */
  it("does not repeat a widest that is also a ladder width", () => {
    expect(derivativeSrcset(`${base}-800.webp`)).toBe(`${base}-320.webp 320w, ${base}-800.webp 800w`);
  });

  it("handles a poster, whose name carries an infix before the width", () => {
    expect(derivativeSrcset(`${base}-poster-800.webp`)).toBe(
      `${base}-poster-320.webp 320w, ${base}-poster-800.webp 800w`,
    );
  });

  it("declines a URL this pipeline did not write", () => {
    expect(derivativeSrcset("https://media.test/media/profile/mark.png")).toBeNull();
  });
});

describe("the way into the full-screen view", () => {
  const image = (n: number, extra: Record<string, unknown> = {}) => ({
    type: "image" as const,
    src: `https://media.test/media/activity-1/p${n}-1600.webp`,
    thumbnail: `https://media.test/media/activity-1/p${n}-320.webp`,
    alt: `Picture ${n}`,
    ...extra,
  });

  const single = (media: unknown[]) =>
    renderRecord({ id: "rec-1", title: "A note", media: media as never }, { heading: "h1" });

  it("puts a named button around every photograph in the track", () => {
    const card = single([image(1), image(2)]);
    const zooms = card.querySelectorAll(".carousel-zoom");

    expect(zooms).toHaveLength(2);
    expect(zooms[1].getAttribute("aria-label")).toBe("View photo 2 full size");
    expect(zooms[0].querySelector("img")).not.toBeNull();
  });

  /* A clip carries its own controls. A button over them would swallow the press
     meant for play, so it does not get one. */
  it("leaves a clip alone", () => {
    const card = single([
      {
        type: "video",
        src: "https://media.test/media/activity-1/clip.mp4",
        poster: "https://media.test/media/activity-1/poster-800.webp",
      },
    ]);

    expect(card.querySelectorAll(".carousel-zoom")).toHaveLength(0);
    expect(card.querySelector(".carousel-slide video")).not.toBeNull();
  });

  /* The lightbox steps through photographs only, so the numbering it is opened
     with counts photographs only — a clip between two of them must not push the
     second one to "3". */
  it("numbers photographs past a clip without counting it", () => {
    const card = single([
      image(1),
      { type: "video", src: "https://media.test/media/activity-1/clip.mp4" },
      image(2),
    ]);
    const zooms = card.querySelectorAll(".carousel-zoom");

    expect(zooms).toHaveLength(2);
    expect(zooms[1].getAttribute("aria-label")).toBe("View photo 2 full size");
  });

  it("opens the black view on the photograph that was pressed", () => {
    document.body.replaceChildren();
    const card = single([image(1), image(2)]);
    document.body.append(card);

    (card.querySelectorAll(".carousel-zoom")[1] as HTMLButtonElement).click();

    const dialog = document.querySelector("dialog.lightbox");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector("img")?.getAttribute("src")).toContain("p2-1600");
  });

  /* The plate opens on the first photograph, so it must not wait on an
     intersection observer — and the ones off to the side of the scroller must
     not all be fetched at once. */
  it("loads the photograph on show eagerly and the rest lazily", () => {
    const imgs = single([image(1), image(2), image(3)]).querySelectorAll<HTMLImageElement>(
      ".carousel-slide img",
    );

    expect([...imgs].map((img) => img.loading)).toEqual(["eager", "lazy", "lazy"]);
  });

  it("asks the plate for the wider derivatives too", () => {
    const img = single([image(1)]).querySelector(".carousel-slide img") as HTMLImageElement;

    expect(img.getAttribute("srcset")).toContain("1600w");
    expect(img.getAttribute("srcset")).toContain("320w");
    expect(img.getAttribute("sizes")).toBe("(max-width: 48rem) 100vw, 46rem");
  });

  /* The 320px file keeps the two jobs it is right for. */
  it("leaves the filmstrip on the thumbnail", () => {
    const thumb = single([image(1), image(2)]).querySelector(".carousel-thumb img") as HTMLImageElement;

    expect(thumb.getAttribute("src")).toBe("https://media.test/media/activity-1/p1-320.webp");
    expect(thumb.getAttribute("srcset")).toBeNull();
  });

  /* The AVIF is half the bytes of the WebP for the same picture, and the
     pipeline has always written one beside every derivative. These four hold
     that it is actually offered, and that the offer is exact: a source naming a
     width the pipeline did not write is a 404 the browser renders as a broken
     image rather than falling back. */
  it("offers the plate the same ladder in AVIF, width for width", () => {
    const slide = single([image(1)]).querySelector(".carousel-slide") as HTMLElement;
    const img = slide.querySelector("img") as HTMLImageElement;
    const source = slide.querySelector("source") as HTMLSourceElement;

    expect(source.type).toBe("image/avif");
    expect(source.getAttribute("srcset")).toBe(
      img.getAttribute("srcset")?.replaceAll(".webp", ".avif"),
    );
    expect(source.getAttribute("sizes")).toBe(img.getAttribute("sizes"));
  });

  it("offers the filmstrip a single AVIF, matching its lack of a ladder", () => {
    const thumb = single([image(1), image(2)]).querySelector(".carousel-thumb") as HTMLElement;
    const source = thumb.querySelector("source") as HTMLSourceElement;

    expect(source.getAttribute("srcset")).toBe("https://media.test/media/activity-1/p1-320.avif");
  });

  /* Caught in a browser, not by a test: the sanitiser writes no poster AVIF,
     because a <video> names its poster in an attribute that takes one URL and
     can never be given a <picture>. Offering one anyway pointed a <source> at a
     file that was never written, and a browser that has chosen a source renders
     nothing rather than falling back to the <img> — so every clip came out
     blank. */
  it("offers the filmstrip no AVIF for a clip, whose picture is a poster", () => {
    const clip = {
      type: "video",
      src: "https://media.test/media/activity-1/c.mp4",
      poster: "https://media.test/media/activity-1/c-poster-1600.webp",
      thumbnail: "https://media.test/media/activity-1/c-poster-320.webp",
    };
    const thumb = single([clip, image(1)]).querySelector(".carousel-thumb") as HTMLElement;

    // The widest poster rather than the 320px one, which is what the filmstrip
    // has always done for a clip. What matters here is the absent <source>.
    expect(thumb.querySelector("img")?.getAttribute("src")).toContain("c-poster-1600.webp");
    expect(thumb.querySelector("source")).toBeNull();
  });

  it("puts the source ahead of the image in every plate", () => {
    const slides = single([image(1), image(2)]).querySelectorAll(".carousel-slide");

    for (const slide of slides) {
      const picture = slide.querySelector("picture") as HTMLElement;
      expect(picture.firstElementChild?.tagName).toBe("SOURCE");
      expect(picture.lastElementChild?.tagName).toBe("IMG");
    }
  });

  /* The wrapper must not swallow either attribute: a <source> has no `loading`,
     and the eager-first arrangement above is what fills the open plate. */
  it("keeps loading on the image rather than the wrapper", () => {
    const slide = single([image(1)]).querySelector(".carousel-slide") as HTMLElement;

    expect(slide.querySelector("picture")?.hasAttribute("loading")).toBe(false);
    expect(slide.querySelector("img")?.getAttribute("loading")).toBe("eager");
  });
});

/* An article published by hand, whose body is the Markdown subset in prose.ts.
   The grammar itself is prose.test.ts's; this is about where the article goes
   and what every other view of the record takes from it. */
describe("an article written in Markdown", () => {
  const infographic = {
    type: "image" as const,
    src: "https://media.test/media/activity-1/info-1024.webp",
    thumbnail: "https://media.test/media/activity-1/info-320.webp",
    alt: "Infographic",
    caption: "At a glance",
  };
  const photo = { ...infographic, src: "https://media.test/media/activity-1/photo-1024.webp", alt: "Photo", caption: null };

  const article = {
    id: "rec-a",
    title: "SCOPE Europe 2026",
    summary: "Three workshops.",
    bodyFormat: "markdown" as const,
    body: "Clinical development is **changing**.\n\n![The three workshops](media:0)\n\n## Workshop 1: Closing the Gaps\n\n*From fragmented data*\n\n- Site selection\n- Feasibility\n\n> Technology alone will not do it.",
    media: [infographic, photo],
  };

  it("renders its sections, lists and quotes on its own page", () => {
    const card = renderRecord(article, { heading: "h1" });
    document.body.append(card);

    expect(card.querySelector(".prose h2 .prose-eyebrow")?.textContent).toBe("Workshop 1");
    expect([...card.querySelectorAll(".prose li")].map((li) => li.textContent)).toEqual(["Site selection", "Feasibility"]);
    expect(card.querySelector(".prose blockquote")?.textContent).toBe("Technology alone will not do it.");
    expect(card.querySelector(".prose strong")?.textContent).toBe("changing");
    // The summary still leads, and the body is not also shown as raw paragraphs.
    expect(card.querySelector(".activity-summary")?.textContent).toBe("Three workshops.");
    expect(card.querySelector(".activity-body")).toBeNull();
  });

  it("puts the picture it names in the text, and leaves only the rest to the carousel", () => {
    const card = renderRecord(article, { heading: "h1" });

    const figure = card.querySelector(".prose figure");
    expect(figure?.querySelector("img")?.getAttribute("src")).toBe(infographic.src);
    expect(figure?.querySelector("img")?.getAttribute("alt")).toBe("The three workshops");
    expect(figure?.querySelector("figcaption")?.textContent).toBe("At a glance");
    expect([...card.querySelectorAll(".carousel-slide img")].map((img) => img.getAttribute("src"))).toEqual([photo.src]);
  });

  it("puts the carousel under the summary and ahead of the article", () => {
    const card = renderRecord(article, { heading: "h1" });
    const order = [...card.querySelectorAll(".activity-summary, .media-carousel, .prose")].map((node) => node.className);

    expect(order).toEqual(["activity-summary", "media-carousel", "prose"]);
  });

  it("opens the placed picture full size", () => {
    const card = renderRecord(article, { heading: "h1" });
    document.body.append(card);

    card.querySelector<HTMLButtonElement>(".prose-zoom")?.click();

    expect(document.querySelector("dialog.lightbox img")?.getAttribute("src")).toBe(infographic.src);
  });

  it("gives a listing card plain prose, with no markup left in it", () => {
    const card = renderRecord(article, { href: "/activities/?v=x", excerpt: true });
    const text = [...card.querySelectorAll(".activity-body")].map((p) => p.textContent).join(" ");

    expect(text).toBe("Clinical development is changing.");
    expect(card.querySelector(".prose")).toBeNull();
  });

  /** The format is opted into. A Telegram note that happens to look like a list stays a note. */
  it("leaves a record without the format exactly as it was", () => {
    const card = renderRecord({ id: "rec-n", title: "A note", body: "## not a heading\n- not a list" }, { heading: "h1" });

    expect(card.querySelector(".prose, ul, h2")).toBeNull();
    expect(card.querySelector(".activity-body")?.textContent).toBe("## not a heading\n- not a list");
  });
});

describe("an article written on the site's editor", () => {
  const picture = {
    type: "image" as const,
    src: "https://media.test/media/activity-aaaaaaaaaaaaaaaa/pic-1200.webp",
    thumbnail: "https://media.test/media/activity-aaaaaaaaaaaaaaaa/pic-320.webp",
    alt: "The room",
    caption: "Day one",
  };
  const clip = { type: "video" as const, src: "https://media.test/media/activity-b/clip-1280.mp4" };

  const article = {
    id: "rec-r",
    title: "Written on the site",
    summary: "A summary.",
    bodyFormat: "rich" as const,
    doc: "docid",
    body: "The lead, in plain text.",
    media: [picture, clip],
  };

  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A section" }] },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Set in Inter", marks: [{ type: "textStyle", attrs: { fontFamily: "Inter" } }] }],
      },
      { type: "figure", attrs: { src: picture.src, alt: "The room, from the door", caption: null } },
    ],
  };

  it("shows its lead at once, then the whole article from its own document", async () => {
    const fetchStub = serve({ "content/articles/rec-r-docid.json": doc });
    const card = renderRecord(article, { heading: "h1" });
    document.body.append(card);

    expect(card.querySelector(".prose p")?.textContent).toBe("The lead, in plain text.");

    await vi.waitFor(() => expect(card.querySelector(".prose-rich h2")?.textContent).toBe("A section"));
    expect(fetchStub).toHaveBeenCalledWith("https://content.test/content/articles/rec-r-docid.json");
    expect((card.querySelector(".prose-rich span") as HTMLElement).style.fontFamily).toContain("Inter");
    expect(card.querySelector(".prose-rich figure img")?.getAttribute("alt")).toBe("The room, from the door");
    // Its picture is in the text; only the video is left for the carousel.
    expect(card.querySelectorAll(".carousel-slide img")).toHaveLength(0);
    expect(card.querySelectorAll(".carousel-slide video")).toHaveLength(1);
  });

  it("keeps the lead when the document cannot be read, and shows every picture above it", async () => {
    serve({});
    const card = renderRecord(article, { heading: "h1" });
    await vi.waitFor(() => expect(card.querySelector(".media-carousel")).not.toBeNull());
    expect(card.querySelector(".prose p")?.textContent).toBe("The lead, in plain text.");
    expect(card.querySelector(".prose-rich")).toBeNull();
    // The lead places nothing, so nothing is left out of the carousel.
    expect(card.querySelectorAll(".carousel-slide img")).toHaveLength(1);
    expect(card.querySelectorAll(".carousel-slide video")).toHaveLength(1);
  });

  /* The live record that found this: published by hand as rich, three pictures
     on the record and none in its document. Its page showed no pictures at all,
     because every picture of a rich record was taken to be one its text placed. */
  it("shows the pictures its document does not place", async () => {
    const other = { ...picture, src: "https://media.test/media/activity-c/other-960.webp", alt: "Another" };
    serve({
      "content/articles/rec-r-docid.json": { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Words only." }] }] },
    });
    const card = renderRecord({ ...article, media: [picture, other] }, { heading: "h1" });

    await vi.waitFor(() => expect(card.querySelector(".prose-rich")).not.toBeNull());
    expect([...card.querySelectorAll(".carousel-slide img")].map((img) => img.getAttribute("src"))).toEqual([
      picture.src,
      other.src,
    ]);
    const order = [...card.querySelectorAll(".activity-summary, .media-carousel, .prose-rich")].map((node) => node.classList[0]);
    expect(order).toEqual(["activity-summary", "media-carousel", "prose"]);
  });

  it("leaves out only the pictures its document places", async () => {
    const other = { ...picture, src: "https://media.test/media/activity-c/other-960.webp", alt: "Another" };
    serve({ "content/articles/rec-r-docid.json": doc });
    const card = renderRecord({ ...article, media: [picture, other] }, { heading: "h1" });

    await vi.waitFor(() => expect(card.querySelector(".prose-rich")).not.toBeNull());
    expect([...card.querySelectorAll(".carousel-slide img")].map((img) => img.getAttribute("src"))).toEqual([other.src]);
    expect(card.querySelector(".prose-rich figure img")?.getAttribute("src")).toBe(picture.src);
  });

  it("reads what a document in hand places, for the editor's preview", () => {
    const other = { ...picture, src: "https://media.test/media/activity-c/other-960.webp", alt: "Another" };
    const card = renderRecord({ ...article, media: [picture, other] }, { heading: "h1", doc: doc as never });

    expect([...card.querySelectorAll(".carousel-slide img")].map((img) => img.getAttribute("src"))).toEqual([other.src]);
  });

  it("refuses a document that names a picture on another host", async () => {
    const hostile = { type: "doc", content: [{ type: "figure", attrs: { src: "https://evil.test/x.webp" } }] };
    serve({ "content/articles/rec-r-docid.json": hostile });
    const card = renderRecord(article, { heading: "h1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(card.querySelector("img[src^='https://evil.test']")).toBeNull();
  });

  it("gives a listing card its plain-text lead", () => {
    const card = renderRecord(article, { href: "/activities/?v=x", excerpt: true });
    expect(card.querySelector(".activity-body")?.textContent).toBe("The lead, in plain text.");
    expect(card.querySelector(".prose")).toBeNull();
  });
});
