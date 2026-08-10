/* Static Activity loader (spec §21).
   Reads the public content bucket only: manifest once, then immutable
   records-{id}.json chunks. No Worker, no database, no runtime API. */

interface ActivityMedia {
  type: "image" | "video";
  src: string;
  thumbnail?: string;
  alt?: string | null;
  caption?: string | null;
  poster?: string;
}

interface ActivityRecord {
  id: string;
  title: string;
  summary?: string | null;
  body?: string | null;
  eventDate?: string | null;
  tags?: string[];
  media?: ActivityMedia[];
}

interface Manifest {
  schemaVersion: number;
  records: Array<{ id: string }>;
}

const CONTENT_BASE = import.meta.env.VITE_CONTENT_BASE_URL?.replace(/\/$/, "");

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function note(section: HTMLElement, message: string) {
  section.querySelector(".activity-note")?.remove();
  section.append(el("p", "activity-note", message));
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.json();
}

function parseChunk(data: unknown): ActivityRecord[] {
  if (!Array.isArray(data)) throw new Error("chunk is not an array");
  return data.filter((r): r is ActivityRecord => {
    return typeof r === "object" && r !== null && typeof (r as ActivityRecord).id === "string" && typeof (r as ActivityRecord).title === "string";
  });
}

async function loadRecords(): Promise<ActivityRecord[]> {
  const manifest = (await fetchJson(`${CONTENT_BASE}/content/manifest.json`)) as Manifest;
  const chunks = await Promise.allSettled(
    manifest.records.map((entry) => fetchJson(`${CONTENT_BASE}/content/records-${entry.id}.json`).then(parseChunk))
  );
  const records: ActivityRecord[] = [];
  for (const chunk of chunks) {
    if (chunk.status === "fulfilled") records.push(...chunk.value);
    else console.warn("Skipping unreadable activity chunk:", chunk.reason);
  }
  return records;
}

function sortRecords(records: ActivityRecord[], ascending: boolean): ActivityRecord[] {
  return [...records].sort((a, b) => {
    const cmp = (a.eventDate ?? "").localeCompare(b.eventDate ?? "");
    return ascending ? cmp : -cmp;
  });
}

function renderRecord(record: ActivityRecord): HTMLElement {
  const card = el("article", "activity-card");
  card.append(el("h3", undefined, record.title));
  if (record.eventDate) card.append(el("p", "activity-date", record.eventDate));
  if (record.summary) card.append(el("p", "activity-summary", record.summary));
  if (record.body) card.append(el("p", "activity-body", record.body));
  for (const media of record.media ?? []) {
    if (media.type === "image") {
      const figure = el("figure", "activity-media");
      const img = new Image();
      img.src = media.thumbnail ?? media.src;
      img.alt = media.alt ?? "";
      img.loading = "lazy";
      figure.append(img);
      if (media.caption) figure.append(el("figcaption", undefined, media.caption));
      card.append(figure);
    } else if (media.type === "video") {
      const figure = el("figure", "activity-media");
      const video = document.createElement("video");
      video.src = media.src;
      // preload="none" with a poster: the frame is a WebP of a few tens of KB
      // and shows immediately, while the clip's megabytes are fetched only if
      // someone presses play. Without the poster the element would be a blank
      // box, since nothing has been downloaded to draw.
      const poster = media.poster ?? media.thumbnail;
      if (poster) video.poster = poster;
      video.preload = "none";
      video.controls = true;
      // Or iOS Safari takes the video fullscreen the moment it starts.
      video.playsInline = true;
      // A video has no alt attribute; the same words become its accessible name.
      if (media.alt) video.setAttribute("aria-label", media.alt);
      figure.append(video);
      if (media.caption) figure.append(el("figcaption", undefined, media.caption));
      card.append(figure);
    }
  }
  if (record.tags?.length) {
    const tags = el("p", "activity-tags");
    for (const tag of record.tags) tags.append(el("span", "activity-tag", tag));
    card.append(tags);
  }
  return card;
}

export function renderActivity(section: HTMLElement, title: string) {
  section.append(el("h2", undefined, title));

  if (!CONTENT_BASE) {
    note(section, "Recent activities will appear here soon.");
    return;
  }

  const list = el("div", "activity-list");
  section.append(list);

  // Placeholder cards rather than a spinner: they occupy roughly the space the
  // real records will, so the page does not lurch when the feed arrives.
  const skeleton = el("div", "activity-list activity-skeleton");
  skeleton.setAttribute("role", "status");
  skeleton.setAttribute("aria-busy", "true");
  skeleton.setAttribute("aria-label", "Loading recent activities");
  for (let i = 0; i < 2; i++) skeleton.append(el("div", "activity-skeleton-card"));
  section.append(skeleton);

  let records: ActivityRecord[] = [];
  let ascending = false;

  const paint = () => {
    list.replaceChildren(...sortRecords(records, ascending).map(renderRecord));
  };

  loadRecords()
    .then((loaded) => {
      skeleton.remove();
      records = loaded;
      if (records.length === 0) {
        note(section, "No activities published yet.");
        return;
      }
      const toggle = el("button", "activity-sort", "Oldest first") as HTMLButtonElement;
      toggle.addEventListener("click", () => {
        ascending = !ascending;
        toggle.textContent = ascending ? "Newest first" : "Oldest first";
        paint();
      });
      section.insertBefore(toggle, list);
      paint();
    })
    .catch((error) => {
      skeleton.remove();
      console.warn("Activity feed unavailable:", error);
      note(section, "Activities are unavailable right now. Please check back later.");
    });
}
