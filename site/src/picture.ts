/* Serving the AVIF the pipeline already wrote.
   The sanitiser encodes an AVIF beside every WebP and the media workflow
   uploads both, but until this module existed nothing ever asked for one: every
   emission site wrote a bare <img> pointing at the .webp. Measured on published
   derivatives the AVIF is about half the bytes for the same picture, so the
   whole of that saving was being encoded, stored and then left on the shelf.

   Deliberately import-free, and it stays that way. activity.ts and lightbox.ts
   already import each other; adding a third participant to that cycle to fetch
   a six-line helper would be a worse trade than a module with no dependencies. */

/**
 * The AVIF beside a WebP derivative, or null when there is not one.
 *
 * Null rather than a guess for anything that does not end in `.webp`, which is
 * the point of the function: the masthead mark is a PNG, the favicons are PNGs,
 * and a URL this pipeline did not write has no derivative ladder at all. A
 * `<source>` whose file 404s does not fall back to the `<img>` beside it — the
 * browser has already committed to the source by then and shows a broken image
 * — so every caller has to be able to ask "is there one?" and get an honest no.
 */
export function avifFrom(url: string): string | null {
  return /\.webp$/i.test(url) ? url.replace(/\.webp$/i, ".avif") : null;
}

/**
 * The same, across a whole srcset.
 *
 * A srcset is `url 320w, url 800w, …`, and only the URLs move. Returns null
 * unless every entry converted, because a mixed set would offer the browser a
 * choice between formats at different widths and let it pick the one that is
 * not there.
 */
export function avifSrcset(srcset: string): string | null {
  const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;

  const converted = entries.map((entry) => {
    const [url, ...rest] = entry.split(/\s+/);
    const avif = avifFrom(url);
    return avif === null ? null : [avif, ...rest].join(" ");
  });

  return converted.every((entry) => entry !== null) ? converted.join(", ") : null;
}

/**
 * `img` wrapped in a `<picture>` that offers the AVIF first, or `img` alone.
 *
 * Returns the image untouched when there is no AVIF to offer, so a caller can
 * hand this any image at all and get back something it can append either way.
 *
 * `loading` and `decoding` stay on the `<img>` and are never copied onto the
 * wrapper or the source. They govern the whole element from there — a `<source>`
 * has no `loading` attribute — and moving them is what would break the hobby
 * panel that flips its image to eager when its tab is opened (sections.ts) and
 * the carousel's eager-first, lazy-rest arrangement.
 *
 * The wrapper is laid out with `display: contents` (styles.css), so it generates
 * no box: the `<img>` stays the direct layout child of whatever plate it sits
 * in. That is load-bearing rather than tidy. Half the image rules on this site
 * resolve a percentage height against the plate, and an inline wrapper with an
 * auto height between them severs that chain — which is how a full-screen
 * photograph once ran off the bottom of the lightbox, and how a shrink-wrapped
 * zoom button once stopped Chrome fetching a lazy image at all.
 */
export function pictureFor(
  img: HTMLImageElement,
  avif: string | null,
  sizes?: string,
): HTMLElement {
  if (avif === null) return img;

  const picture = document.createElement("picture");
  const source = document.createElement("source");
  source.type = "image/avif";
  source.srcset = avif;
  if (sizes) source.sizes = sizes;
  picture.append(source, img);
  return picture;
}

/**
 * A 1×1 AVIF, and whether this browser can decode it.
 *
 * Only the lightbox's neighbour prefetch needs this. Everywhere else the
 * browser answers the question itself by choosing between a `<source>` and an
 * `<img>`; a prefetch has no such element to choose with, and fetching the
 * wrong format would warm the cache with a file that is never read.
 *
 * A wrong answer here costs one wasted request for a photograph the reader may
 * never open. It cannot produce a broken image, which is why a probe is
 * acceptable here and would not be as a gate on what gets rendered.
 */
const PROBE =
  "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAo" +
  "aGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAAB" +
  "AAEAAAABAAABGgAAAB0AAABoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABL" +
  "aXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAAC" +
  "AAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgABogQEDQgMgkQAAAAB8dSLfI=";

let probe: Promise<boolean> | null = null;

export function avifSupported(): Promise<boolean> {
  if (probe === null) {
    probe = new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.width > 0 && img.height > 0);
      img.onerror = () => resolve(false);
      img.src = PROBE;
    });
  }
  return probe;
}
