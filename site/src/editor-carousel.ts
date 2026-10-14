/**
 * The editor's carousel: the pictures and clips an article shows above its
 * text, in the order it shows them.
 *
 * The text places its own pictures, as figures; everything else an article
 * shows is here. Publishing sends this list beside the document, and the
 * Worker puts it first in the record's media, so its first item is the cover a
 * listing card leads with.
 *
 * An upload takes the road a picture in the text takes — the same endpoint,
 * the same sanitiser — and sits in the list as "Preparing…" until the editor's
 * poll finds it ready. Clips come only this way: the text has nowhere to play
 * one.
 */
import { el, type ActivityMedia } from "./activity";

export interface CarouselEntry {
  /** The type the upload was, or the file is. */
  type: "image" | "video";
  /** Null until the sanitiser has made it. */
  src: string | null;
  thumbnail?: string;
  poster?: string;
  alt: string | null;
  caption: string | null;
  /** The upload being waited on: "local-…" before the Worker answers, its id after. */
  upload: string | null;
  failed: boolean;
  /** The file's own name, for the list while there is no picture to show. */
  name?: string;
}

/** What the Worker says of an upload once it is ready (worker/src/editor/media.ts). */
export interface ReadyUpload {
  type: "image" | "video";
  src: string;
  thumbnail?: string;
  poster?: string;
}

/** The ceiling the Worker holds every upload to: Telegram's, which the sanitiser was built around. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const ACCEPTED = "image/*,video/mp4,video/quicktime,video/webm";

export interface CarouselOptions {
  initial: CarouselEntry[];
  /** Sends the file and answers its upload id, or throws. */
  upload: (file: File) => Promise<string>;
  /** A file that was never sent, or that the Worker refused. */
  onRejected: (file: File, error: unknown) => void;
  /** Anything that changes what would be published. */
  onChange: () => void;
}

export interface CarouselPanel {
  element: HTMLElement;
  /** Every entry, for the draft this browser keeps. */
  entries(): CarouselEntry[];
  /** The entries ready to publish, in order. */
  media(): ActivityMedia[];
  /** Upload ids still being made, for the editor's poll. */
  pending(): string[];
  failed(): number;
  ready(uploadId: string, answer: ReadyUpload): void;
  fail(uploadId: string): void;
}

/** The record's items the text does not place, as the list opens with them. */
export function entriesFrom(media: ActivityMedia[], placed: ReadonlySet<string>): CarouselEntry[] {
  return media
    .filter((item) => item.type === "video" || !placed.has(item.src))
    .map((item) => ({
      type: item.type,
      src: item.src,
      ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
      ...(item.poster ? { poster: item.poster } : {}),
      alt: item.alt ?? null,
      caption: item.caption ?? null,
      upload: null,
      failed: false,
    }));
}

/**
 * A draft from before the carousel existed has no list, and one saved in the
 * middle of an upload may hold an entry whose request never answered. Neither
 * can be finished, so only what can is kept.
 */
export function restoredEntries(saved: unknown): CarouselEntry[] | null {
  if (!Array.isArray(saved)) return null;
  return (saved as CarouselEntry[]).filter(
    (entry) =>
      entry &&
      (entry.type === "image" || entry.type === "video") &&
      !entry.failed &&
      (typeof entry.src === "string" || (typeof entry.upload === "string" && !entry.upload.startsWith("local-"))),
  );
}

function small(label: string, title: string, onClick: () => void, className = "editor-button"): HTMLButtonElement {
  const button = el("button", className, label) as HTMLButtonElement;
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}

export function createCarouselPanel(options: CarouselOptions): CarouselPanel {
  const entries: CarouselEntry[] = options.initial.map((entry) => ({ ...entry }));
  let counter = 0;

  const element = el("section", "editor-carousel");
  element.setAttribute("aria-labelledby", "editor-carousel-title");
  const head = el("div", "editor-carousel-head");
  const title = el("h2", "editor-label label", "Carousel");
  title.id = "editor-carousel-title";
  const hint = el(
    "p",
    "editor-hint",
    "Shown under the summary, before the text. The first one is the cover on the list of activities. Photos and videos, up to 20 MB each.",
  );

  const input = Object.assign(document.createElement("input"), { type: "file", accept: ACCEPTED, multiple: true });
  input.hidden = true;
  const add = el("button", "editor-action", "Add media") as HTMLButtonElement;
  add.type = "button";
  add.title = "Add photos or videos to the carousel";
  add.addEventListener("click", () => input.click());
  head.append(title, add, input);

  const list = el("ol", "editor-carousel-list");
  const empty = el("p", "editor-carousel-empty", "Nothing in the carousel yet.");
  element.append(head, hint, list, empty);

  const changed = () => {
    render();
    options.onChange();
  };

  const move = (entry: CarouselEntry, by: number) => {
    const from = entries.indexOf(entry);
    const to = from + by;
    if (from === -1 || to < 0 || to >= entries.length) return;
    entries.splice(from, 1);
    entries.splice(to, 0, entry);
    changed();
    // Keep the keyboard on the item that moved, so it can be pressed again —
    // or on its other arrow, once it has reached the end this one points at.
    const moved = list.children[to];
    const same = moved?.querySelector<HTMLButtonElement>(by < 0 ? "[data-move='up']" : "[data-move='down']");
    const other = moved?.querySelector<HTMLButtonElement>(by < 0 ? "[data-move='down']" : "[data-move='up']");
    (same && !same.disabled ? same : other)?.focus();
  };

  const remove = (entry: CarouselEntry) => {
    const index = entries.indexOf(entry);
    if (index === -1) return;
    entries.splice(index, 1);
    changed();
  };

  function face(entry: CarouselEntry): HTMLElement {
    const frame = el("div", "editor-carousel-face plate");
    const picture = entry.type === "video" ? (entry.poster ?? entry.thumbnail) : (entry.thumbnail ?? entry.src);
    if (entry.src && picture) {
      const img = new Image();
      img.src = picture;
      img.alt = "";
      img.loading = "lazy";
      frame.append(img);
    } else if (entry.src) {
      frame.append(el("span", "editor-figure-note", "Clip"));
    } else {
      frame.append(el("span", "editor-figure-note", entry.failed ? "Failed" : "Preparing…"));
    }
    if (entry.type === "video") frame.append(el("span", "editor-carousel-kind label", "Video"));
    return frame;
  }

  function row(entry: CarouselEntry, index: number): HTMLElement {
    const item = el("li", "editor-carousel-item");
    if (entry.failed) item.classList.add("is-failed");
    const label = entry.type === "video" ? "Video" : "Photo";

    const text = el("div", "editor-carousel-text");
    if (!entry.src && entry.name) text.append(el("span", "editor-carousel-name", entry.name));

    const alt = Object.assign(document.createElement("input"), {
      type: "text",
      value: entry.alt ?? "",
      maxLength: 500,
      placeholder: entry.type === "video" ? "What the video shows" : "What the photo shows",
    });
    alt.setAttribute("aria-label", `${label} ${index + 1}: description for screen readers`);
    alt.addEventListener("input", () => {
      entry.alt = alt.value.trim() || null;
      options.onChange();
    });
    const caption = Object.assign(document.createElement("input"), {
      type: "text",
      value: entry.caption ?? "",
      maxLength: 500,
      placeholder: "Caption (optional)",
    });
    caption.setAttribute("aria-label", `${label} ${index + 1}: caption`);
    caption.addEventListener("input", () => {
      entry.caption = caption.value.trim() || null;
      options.onChange();
    });
    text.append(alt, caption);

    const controls = el("div", "editor-carousel-controls");
    const up = small("↑", `Move ${label.toLowerCase()} ${index + 1} earlier`, () => move(entry, -1));
    up.dataset.move = "up";
    up.disabled = index === 0;
    const down = small("↓", `Move ${label.toLowerCase()} ${index + 1} later`, () => move(entry, 1));
    down.dataset.move = "down";
    down.disabled = index === entries.length - 1;
    const drop = small(
      "Remove",
      `Remove ${label.toLowerCase()} ${index + 1} from the carousel`,
      () => remove(entry),
      "editor-button editor-button--text",
    );
    controls.append(up, down, drop);

    item.append(face(entry), text, controls);
    return item;
  }

  function render() {
    list.replaceChildren(...entries.map(row));
    empty.hidden = entries.length > 0;
  }

  const send = async (file: File) => {
    const entry: CarouselEntry = {
      type: file.type.startsWith("video/") ? "video" : "image",
      src: null,
      alt: null,
      caption: null,
      upload: `local-${Date.now()}-${counter++}`,
      failed: false,
      name: file.name,
    };
    entries.push(entry);
    changed();
    try {
      entry.upload = await options.upload(file);
    } catch (error) {
      entry.failed = true;
      entry.upload = null;
      options.onRejected(file, error);
    }
    changed();
  };

  input.addEventListener("change", () => {
    for (const file of input.files ?? []) {
      // Refused here rather than sent: the Worker would refuse it too, after
      // the whole file had crossed the network to be told so.
      if (file.size > MAX_UPLOAD_BYTES) options.onRejected(file, new RangeError("too large"));
      else void send(file);
    }
    input.value = "";
  });

  render();

  return {
    element,
    entries: () => entries.map((entry) => ({ ...entry })),
    media: () =>
      entries
        .filter((entry): entry is CarouselEntry & { src: string } => entry.src !== null)
        .map((entry) => ({
          type: entry.type,
          src: entry.src,
          ...(entry.thumbnail ? { thumbnail: entry.thumbnail } : {}),
          ...(entry.poster ? { poster: entry.poster } : {}),
          alt: entry.alt,
          caption: entry.caption,
        })),
    pending: () =>
      entries.filter((entry) => entry.src === null && !entry.failed && entry.upload !== null).map((entry) => entry.upload!),
    failed: () => entries.filter((entry) => entry.failed).length,
    ready(uploadId, answer) {
      const entry = entries.find((candidate) => candidate.upload === uploadId);
      if (!entry) return;
      Object.assign(entry, {
        type: answer.type,
        src: answer.src,
        upload: null,
        ...(answer.thumbnail ? { thumbnail: answer.thumbnail } : {}),
        ...(answer.poster ? { poster: answer.poster } : {}),
      });
      delete entry.name;
      changed();
    },
    fail(uploadId) {
      const entry = entries.find((candidate) => candidate.upload === uploadId);
      if (!entry) return;
      entry.failed = true;
      changed();
    },
  };
}
