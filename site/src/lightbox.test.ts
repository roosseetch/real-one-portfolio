/* The full-screen view, and the two things about it that a unit test can hold:
   which file it asks for, and where the arrows land.

   Not tested here, deliberately: modality, the focus trap, `::backdrop` and
   Escape. Those come from the browser's own <dialog>, and happy-dom stubs the
   element without implementing them — the same trap the contact form's
   reportValidity hit. Confirming them means a real browser, and the plan says
   so. */
import { beforeEach, describe, expect, it } from "vitest";

import type { ActivityMedia } from "./activity";
import { openLightbox } from "./lightbox";

function photo(n: number, extra: Partial<ActivityMedia> = {}): ActivityMedia {
  return {
    type: "image",
    src: `https://media.test/media/activity-1/p${n}-1600.webp`,
    thumbnail: `https://media.test/media/activity-1/p${n}-320.webp`,
    alt: `Photo ${n}`,
    ...extra,
  };
}

describe("the full-screen view", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.style.overflow = "";
  });

  it("shows the widest derivative, not the thumbnail", () => {
    const dialog = openLightbox([photo(1)], 0);

    const img = dialog?.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://media.test/media/activity-1/p1-1600.webp");
    expect(img.sizes).toBe("100vw");
    expect(img.alt).toBe("Photo 1");
  });

  it("opens on the photograph that was clicked", () => {
    const dialog = openLightbox([photo(1), photo(2), photo(3)], 2);

    expect(dialog?.querySelector("img")?.getAttribute("src")).toContain("p3-1600");
    expect(dialog?.querySelector(".lightbox-counter")?.textContent).toBe("3 / 3");
  });

  it("moves between photographs and stops at either end", () => {
    const dialog = openLightbox([photo(1), photo(2)], 0);
    const prev = dialog?.querySelector(".lightbox-arrow") as HTMLButtonElement;
    const next = dialog?.querySelectorAll(".lightbox-arrow")[1] as HTMLButtonElement;

    expect(prev.disabled).toBe(true);
    next.click();
    expect(dialog?.querySelector("img")?.getAttribute("src")).toContain("p2-1600");
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
  });

  it("gives a single photograph no arrows to press", () => {
    const dialog = openLightbox([photo(1)], 0);

    expect(dialog?.querySelectorAll(".lightbox-arrow")).toHaveLength(0);
    expect(dialog?.querySelector(".lightbox-bar")).toBeNull();
  });

  it("shows a caption only when there is one", () => {
    const withCaption = openLightbox([photo(1, { caption: "In the studio" })], 0);
    expect(withCaption?.querySelector(".lightbox-caption")?.textContent).toBe("In the studio");
    expect((withCaption?.querySelector(".lightbox-caption") as HTMLElement).hidden).toBe(false);

    document.body.replaceChildren();
    const without = openLightbox([photo(2)], 0);
    expect((without?.querySelector(".lightbox-caption") as HTMLElement).hidden).toBe(true);
  });

  it("takes itself out of the document when it closes", () => {
    const dialog = openLightbox([photo(1)], 0);
    expect(document.body.contains(dialog!)).toBe(true);

    dialog!.close();
    expect(document.body.contains(dialog!)).toBe(false);
  });

  /* The cleanup used to hang off the `close` event alone, and that event did not
     fire in the browser this was tested in: the scroll lock stayed on and the
     article underneath could not be scrolled again. Every route out goes through
     the same idempotent teardown now. */
  it("gives the page back its scrolling however it is dismissed", () => {
    for (const dismiss of [
      (d: HTMLDialogElement) => (d.querySelector(".lightbox-close") as HTMLButtonElement).click(),
      (d: HTMLDialogElement) => d.click(),
      (d: HTMLDialogElement) =>
        d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      (d: HTMLDialogElement) => d.close(),
    ]) {
      document.documentElement.style.overflow = "";
      const dialog = openLightbox([photo(1)], 0)!;

      dismiss(dialog);

      expect(document.documentElement.style.overflow).toBe("");
      expect(document.body.contains(dialog)).toBe(false);
    }
  });

  /* Two routes arriving — a click that closes and the `close` event behind it —
     must not be two teardowns. */
  it("tears down once even when several routes fire", () => {
    document.documentElement.style.overflow = "";
    const dialog = openLightbox([photo(1)], 0)!;

    (dialog.querySelector(".lightbox-close") as HTMLButtonElement).click();
    dialog.dispatchEvent(new Event("close"));
    dialog.click();

    expect(document.documentElement.style.overflow).toBe("");
    expect(document.querySelectorAll("dialog.lightbox")).toHaveLength(0);
  });

  it("does not leave a press on the picture closing it", () => {
    const dialog = openLightbox([photo(1)], 0)!;

    (dialog.querySelector("img") as HTMLImageElement).click();

    expect(document.body.contains(dialog)).toBe(true);
  });

  it("renders nothing for a record with no photographs", () => {
    expect(openLightbox([], 0)).toBeNull();
    expect(document.body.children).toHaveLength(0);
  });
});
