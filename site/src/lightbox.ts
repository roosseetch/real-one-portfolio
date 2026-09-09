/**
 * One photograph, full-screen on a black ground.
 *
 * The plate on an activity page is height-clamped — 26rem at its tallest — so a
 * photograph published at 1600px is read at a few hundred. This is where the
 * rest of it is: the same file the plate already loaded, given the whole
 * viewport and none of the page's warm paper.
 *
 * Built on `<dialog>.showModal()` rather than a div with a large z-index. The
 * native element brings the four things a hand-rolled overlay gets wrong — the
 * page behind it goes inert, focus is trapped inside, Escape closes, and the
 * black is `::backdrop` rather than an element that has to be sized to a
 * viewport that keeps changing.
 *
 * This module and activity.ts import from each other, which is deliberate and
 * safe: everything crossing the boundary is a hoisted function declaration or an
 * erased type, and nothing here runs at module scope. The alternative was
 * threading an opener through RecordOptions, renderRecord and mediaCarousel —
 * three signatures made worse to avoid a cycle that cannot bite.
 */
import { counterText, el, longArrow, type ActivityMedia } from "./activity";

/** A cross, drawn to the same stroke conventions as the carousel's arrows. */
function closeGlyph(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const d of ["M2 2l12 12", "M14 2 2 14"]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * Opens the full-screen view on one photograph of a set.
 *
 * `photos` carries only the photographs, never the clips: a clip already has
 * its own controls in the plate, and arrowing into one here would put a second
 * player on top of the first.
 *
 * Returns the dialog so a caller — and a test — can address it. Null when there
 * is nothing to show.
 */
export function openLightbox(photos: ActivityMedia[], index: number): HTMLDialogElement | null {
  if (photos.length === 0) return null;

  let current = Math.min(Math.max(index, 0), photos.length - 1);
  const opener = document.activeElement as HTMLElement | null;

  const dialog = document.createElement("dialog");
  dialog.className = "lightbox";
  dialog.setAttribute("aria-label", "Photograph, full size");

  const close = el("button", "lightbox-close") as HTMLButtonElement;
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.append(closeGlyph());

  const figure = document.createElement("figure");
  figure.className = "lightbox-figure";

  const img = new Image();
  // The viewport is the box here, so the widest derivative is the right ask and
  // `sizes` says so. No srcset: at 100vw the browser would pick the widest one
  // on any screen worth opening this on, and offering it a 320px file it will
  // not choose is a longer attribute for nothing.
  img.sizes = "100vw";
  img.decoding = "async";
  figure.append(img);

  const caption = document.createElement("figcaption");
  caption.className = "lightbox-caption";
  figure.append(caption);

  dialog.append(close, figure);

  const single = photos.length === 1;
  const prev = el("button", "lightbox-arrow") as HTMLButtonElement;
  const next = el("button", "lightbox-arrow") as HTMLButtonElement;
  const counter = el("span", "lightbox-counter label tnum");

  if (!single) {
    prev.type = "button";
    prev.setAttribute("aria-label", "Previous");
    prev.append(longArrow(true));
    next.type = "button";
    next.setAttribute("aria-label", "Next");
    next.append(longArrow(false));
    // Where in the set the reader is, announced when it changes rather than on
    // every repaint.
    counter.setAttribute("aria-live", "polite");

    const bar = el("div", "lightbox-bar");
    bar.append(prev, counter, next);
    dialog.append(bar);
  }

  function show(to: number) {
    current = Math.min(Math.max(to, 0), photos.length - 1);
    const item = photos[current];

    img.src = item.src;
    img.alt = item.alt ?? "";
    caption.textContent = item.caption ?? "";
    caption.hidden = caption.textContent === "";

    if (!single) {
      counter.textContent = counterText(current, photos.length);
      prev.disabled = current === 0;
      next.disabled = current === photos.length - 1;

      // The neighbours, so an arrow press paints instead of waiting on the
      // network. Costs one request each for a file the reader is one keystroke
      // from asking for anyway.
      for (const neighbour of [photos[current - 1], photos[current + 1]]) {
        if (neighbour) new Image().src = neighbour.src;
      }
    }
  }

  prev.addEventListener("click", () => show(current - 1));
  next.addEventListener("click", () => show(current + 1));
  close.addEventListener("click", () => dialog.close());

  // A press anywhere that is not the picture, its caption or a control closes.
  // Tested against the target rather than against the dialog itself, because a
  // dialog stretched to the viewport means the empty space beside a portrait
  // photograph belongs to the figure, not to the backdrop.
  dialog.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target?.closest("img, button, figcaption")) dialog.close();
  });

  dialog.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (single) return;
    if (key === "ArrowLeft") show(current - 1);
    else if (key === "ArrowRight") show(current + 1);
    else return;
    event.preventDefault();
  });

  // showModal makes the page behind inert but does not stop it scrolling, so a
  // wheel over the black ground would move the article underneath it.
  const scrollLock = document.documentElement.style.overflow;
  dialog.addEventListener("close", () => {
    document.documentElement.style.overflow = scrollLock;
    dialog.remove();
    // Browsers return focus here on their own; doing it explicitly covers the
    // ones that do not, and costs nothing where they do.
    opener?.focus?.();
  });

  show(current);
  document.body.append(dialog);

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    document.documentElement.style.overflow = "hidden";
  } else {
    // No modality, no focus trap and no backdrop — but the content is there and
    // Escape still closes. Only a DOM without native dialog support reaches
    // this, which today means the test environment rather than a browser.
    dialog.setAttribute("open", "");
  }

  return dialog;
}
