/**
 * The AVIF wrapper, on its own.
 *
 * The rule these tests exist to hold is that a `<source>` is only ever offered
 * for a file we know the pipeline wrote. A source whose file 404s does not fall
 * back to the `<img>` beside it — the browser has already committed — so every
 * "null" case here is a broken photograph that did not happen.
 */
import { describe, expect, it } from "vitest";

import { avifFrom, avifSrcset, pictureFor } from "./picture";

const WEBP = "https://media.example/media/activity-a/b-1600.webp";

describe("avifFrom", () => {
  it("names the AVIF beside a WebP derivative", () => {
    expect(avifFrom(WEBP)).toBe("https://media.example/media/activity-a/b-1600.avif");
  });

  it("is case-insensitive about the extension it replaces", () => {
    expect(avifFrom("https://media.example/a-800.WEBP")).toBe("https://media.example/a-800.avif");
  });

  /** The masthead mark and both favicons are PNGs, and no AVIF was ever written. */
  it("refuses anything that is not a WebP", () => {
    expect(avifFrom("https://media.example/media/profile/mark-730.png")).toBeNull();
    expect(avifFrom("https://media.example/media/profile/favicon-32.png")).toBeNull();
    expect(avifFrom("https://media.example/a-1920.mp4")).toBeNull();
    expect(avifFrom("https://media.example/no-extension")).toBeNull();
  });

  /** Only the end of the name, or a directory called `.webp/` would qualify. */
  it("does not match a .webp anywhere but the end", () => {
    expect(avifFrom("https://media.example/x.webp/y.png")).toBeNull();
  });
});

describe("avifSrcset", () => {
  it("converts every URL and leaves the descriptors alone", () => {
    expect(avifSrcset("https://m/a-320.webp 320w, https://m/a-800.webp 800w")).toBe(
      "https://m/a-320.avif 320w, https://m/a-800.avif 800w",
    );
  });

  it("handles a single entry with no descriptor", () => {
    expect(avifSrcset("https://m/a-320.webp")).toBe("https://m/a-320.avif");
  });

  /** All or nothing: a mixed set would let the browser pick the file we do not have. */
  it("returns null when any entry is not a WebP", () => {
    expect(avifSrcset("https://m/a-320.webp 320w, https://m/a-800.png 800w")).toBeNull();
  });

  it("returns null for an empty set", () => {
    expect(avifSrcset("")).toBeNull();
  });
});

describe("pictureFor", () => {
  it("puts the source before the image, typed as AVIF", () => {
    const img = new Image();
    img.src = WEBP;
    const wrapper = pictureFor(img, avifFrom(WEBP)) as HTMLElement;

    expect(wrapper.tagName).toBe("PICTURE");
    const source = wrapper.firstElementChild as HTMLSourceElement;
    expect(source.tagName).toBe("SOURCE");
    expect(source.type).toBe("image/avif");
    expect(source.getAttribute("srcset")).toBe(avifFrom(WEBP));
    // Order is the selection order: the browser takes the first source it can
    // use and only reaches the <img> when none matched.
    expect(wrapper.lastElementChild).toBe(img);
  });

  /** So a caller can hand this any image and append what comes back. */
  it("returns the image untouched when there is no AVIF to offer", () => {
    const img = new Image();
    expect(pictureFor(img, null)).toBe(img);
  });

  it("passes sizes to the source only when it is given one", () => {
    const img = new Image();
    const withSizes = pictureFor(img, "a.avif 320w", "100vw");
    expect(withSizes.querySelector("source")?.getAttribute("sizes")).toBe("100vw");

    const without = pictureFor(new Image(), "a.avif");
    expect(without.querySelector("source")?.hasAttribute("sizes")).toBe(false);
  });

  /**
   * These two govern the whole <picture> from the <img>, and a <source> has no
   * `loading` at all. Moving either onto the wrapper is what would stop a hobby
   * panel fetching its photograph when its tab is opened.
   */
  it("leaves loading and decoding on the image", () => {
    const img = new Image();
    img.loading = "lazy";
    img.decoding = "async";
    const wrapper = pictureFor(img, "a.avif") as HTMLElement;

    expect(wrapper.hasAttribute("loading")).toBe(false);
    expect(wrapper.querySelector("source")?.hasAttribute("loading")).toBe(false);
    expect(img.loading).toBe("lazy");
    expect(img.decoding).toBe("async");
  });
});
