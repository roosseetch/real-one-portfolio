import { describe, expect, it, vi } from "vitest";

import type { ActivityMedia } from "./activity";
import { createCarouselPanel, entriesFrom, MAX_UPLOAD_BYTES, restoredEntries, type CarouselEntry } from "./editor-carousel";

const MEDIA = "https://media.test/media/activity-aaaaaaaaaaaaaaaa";
const photo = (n: number): ActivityMedia => ({
  type: "image",
  src: `${MEDIA}/p${n}-1200.webp`,
  thumbnail: `${MEDIA}/p${n}-320.webp`,
  alt: `Photo ${n}`,
  caption: null,
});
const clip: ActivityMedia = {
  type: "video",
  src: `${MEDIA}/c-1280.mp4`,
  poster: `${MEDIA}/c-poster-1280.webp`,
  alt: null,
  caption: "The hall",
};

function panel(initial: CarouselEntry[] = [], upload = vi.fn(async () => "uploadid0000001")) {
  const onChange = vi.fn();
  const onRejected = vi.fn();
  const created = createCarouselPanel({ initial, upload, onChange, onRejected });
  document.body.replaceChildren(created.element);
  return { created, onChange, onRejected, upload };
}

function choose(element: HTMLElement, files: File[]) {
  const input = element.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
}

describe("what the carousel opens with", () => {
  /* The record that found this: three pictures, none of them in its text. */
  it("is every picture the text does not place, and every clip", () => {
    const entries = entriesFrom([photo(1), photo(2), clip], new Set([photo(2).src]));
    expect(entries.map((entry) => entry.src)).toEqual([photo(1).src, clip.src]);
    expect(entries[1]).toMatchObject({ type: "video", poster: clip.poster, caption: "The hall" });
  });

  it("drops what a kept draft cannot finish", () => {
    const kept = restoredEntries([
      { type: "image", src: photo(1).src, alt: null, caption: null, upload: null, failed: false },
      { type: "image", src: null, alt: null, caption: null, upload: "uploadid0000001", failed: false },
      { type: "image", src: null, alt: null, caption: null, upload: "local-1-0", failed: false },
      { type: "video", src: null, alt: null, caption: null, upload: "uploadid0000002", failed: true },
    ]);
    expect(kept?.map((entry) => entry.upload ?? entry.src)).toEqual([photo(1).src, "uploadid0000001"]);
    expect(restoredEntries(undefined)).toBeNull();
  });
});

describe("the carousel panel", () => {
  it("lists each item whole, with its words, and says when it is empty", () => {
    const { created } = panel(entriesFrom([photo(1), clip], new Set()));
    const items = created.element.querySelectorAll(".editor-carousel-item");

    expect(items).toHaveLength(2);
    expect(items[0].querySelector("img")?.getAttribute("src")).toBe(photo(1).thumbnail);
    expect(items[1].querySelector("img")?.getAttribute("src")).toBe(clip.poster);
    expect(items[1].querySelector(".editor-carousel-kind")?.textContent).toBe("Video");
    expect((items[0].querySelector("input") as HTMLInputElement).value).toBe("Photo 1");
    expect(created.element.querySelector<HTMLElement>(".editor-carousel-empty")?.hidden).toBe(true);

    expect(panel().created.element.querySelector<HTMLElement>(".editor-carousel-empty")?.hidden).toBe(false);
  });

  it("reorders, removes, and takes new words, in what it would publish", () => {
    const { created, onChange } = panel(entriesFrom([photo(1), photo(2), photo(3)], new Set()));
    const press = (index: number, selector: string) =>
      created.element.querySelectorAll(".editor-carousel-item")[index].querySelector<HTMLButtonElement>(selector)!.click();

    press(2, "[data-move='up']");
    expect(created.media().map((item) => item.src)).toEqual([photo(1).src, photo(3).src, photo(2).src]);

    press(0, "[aria-label^='Remove']");
    expect(created.media().map((item) => item.src)).toEqual([photo(3).src, photo(2).src]);

    const caption = created.element.querySelectorAll<HTMLInputElement>(".editor-carousel-item input")[1];
    caption.value = " On the stand ";
    caption.dispatchEvent(new Event("input"));
    expect(created.media()[0].caption).toBe("On the stand");
    expect(onChange).toHaveBeenCalled();

    const first = created.element.querySelector<HTMLButtonElement>("[data-move='up']")!;
    expect(first.disabled).toBe(true);
  });

  /* Moved to the top, its own arrow is disabled and cannot hold the focus. */
  it("keeps the keyboard on the item it moved, even at the end of the list", () => {
    const { created } = panel(entriesFrom([photo(1), photo(2)], new Set()));
    created.element.querySelectorAll<HTMLButtonElement>("[data-move='up']")[1].click();

    expect(created.media()[0].src).toBe(photo(2).src);
    expect(document.activeElement).toBe(created.element.querySelector("[data-move='down']"));
  });

  it("uploads a chosen video, waits for it, then publishes it with its poster", async () => {
    const { created, upload } = panel();
    choose(created.element, [new File(["x"], "hall.mov", { type: "video/quicktime" })]);

    expect(created.element.querySelector(".editor-carousel-face")?.textContent).toContain("Preparing");
    await vi.waitFor(() => expect(created.pending()).toEqual(["uploadid0000001"]));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(created.media()).toEqual([]);

    created.ready("uploadid0000001", { type: "video", src: clip.src, poster: clip.poster });
    expect(created.pending()).toEqual([]);
    expect(created.media()).toEqual([{ type: "video", src: clip.src, poster: clip.poster, alt: null, caption: null }]);
  });

  it("refuses a file over 20 MB without sending it, and marks one the Worker refused", async () => {
    const refused = vi.fn(async () => {
      throw new Error("415");
    });
    const { created, onRejected, upload } = panel([], refused);

    const big = new File(["x"], "long.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
    choose(created.element, [big]);
    expect(upload).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(big, expect.any(RangeError));

    choose(created.element, [new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    await vi.waitFor(() => expect(created.failed()).toBe(1));
    expect(created.element.querySelector(".editor-carousel-item")?.classList.contains("is-failed")).toBe(true);
  });
});
