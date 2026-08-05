import { facts, personality, portfolio, mediaRef } from "./profile";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function formatDate(value: string | null): string {
  if (!value) return "";
  if (value === "present") return "present";
  const [year, month] = value.split("-");
  return month ? `${MONTHS[Number(month) - 1]} ${year}` : year;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const MEDIA_BASE = import.meta.env.VITE_MEDIA_BASE_URL?.replace(/\/$/, "");

/** Widths published by the sanitization pipeline for each media reference.
    Sources vary in size and the pipeline never upscales, so the available
    widths differ per image. */
const PUBLISHED_WIDTHS: Record<string, number[]> = {
  hero: [800, 991],
  "hobby-jogging": [800, 1080],
  "hobby-gym": [738],
  "hobby-stretching": [800, 1600],
  "hobby-ballet": [781],
};

/** Renders a published photo, or an accent-tinted block carrying the alt text
    when no media base URL is configured. The placeholder keeps layout and
    accessibility real for a deployment whose media pipeline has not run yet. */
function mediaSlot(refId: string | null, className: string): HTMLElement {
  const ref = refId ? mediaRef(refId) : null;
  const widths = refId ? PUBLISHED_WIDTHS[refId] : undefined;

  if (MEDIA_BASE && refId && widths?.length) {
    const img = new Image();
    const url = (w: number) => `${MEDIA_BASE}/media/profile/${refId}-${w}.webp`;
    img.className = `${className} media-photo`;
    img.src = url(widths[widths.length - 1]);
    if (widths.length > 1) {
      img.srcset = widths.map((w) => `${url(w)} ${w}w`).join(", ");
      img.sizes = "(max-width: 48rem) 100vw, 40rem";
    }
    img.alt = ref?.alt ?? "";
    img.loading = refId === "hero" ? "eager" : "lazy";
    img.decoding = "async";
    return img;
  }

  const slot = el("div", `${className} media-slot`);
  slot.setAttribute("role", "img");
  slot.setAttribute("aria-label", ref?.alt ?? "Photo placeholder");
  slot.append(el("span", "media-slot-label", ref?.alt ?? "Photo"));
  return slot;
}

function sectionTitle(id: string): string {
  return portfolio.sections.find((s) => s.id === id)?.title ?? id;
}

export function renderHero(section: HTMLElement) {
  section.classList.add("hero");
  const intro = personality.aboutText?.split("\n\n")[0] ?? "";

  const text = el("div", "hero-text");
  text.append(el("h1", "hero-title", sectionTitle("hero")));
  text.append(el("p", "hero-intro", intro));

  const actions = el("div", "hero-actions");
  const story = el("a", "button primary", "Discover my story") as HTMLAnchorElement;
  story.href = "#about";
  const activities = el("a", "button", "See recent activities") as HTMLAnchorElement;
  activities.href = "#activity";
  actions.append(story, activities);
  text.append(actions);

  section.append(text, mediaSlot("hero", "hero-portrait"));
}

export function renderAbout(section: HTMLElement) {
  section.append(el("h2", undefined, sectionTitle("about")));
  for (const paragraph of (personality.aboutText ?? "").split("\n\n")) {
    section.append(el("p", "about-paragraph", paragraph));
  }
}

export function renderExperience(section: HTMLElement) {
  section.append(el("h2", undefined, sectionTitle("experience")));
  const list = el("div", "experience-list");
  for (const job of facts.experience) {
    const card = el("article", "experience-card");
    card.append(el("h3", undefined, job.title));
    const meta = [job.organization, [formatDate(job.start), formatDate(job.end)].filter(Boolean).join(" – ")]
      .filter(Boolean)
      .join(" · ");
    card.append(el("p", "experience-meta", meta));
    if (job.summary) card.append(el("p", undefined, job.summary));
    const highlights = "highlights" in job ? job.highlights : undefined;
    if (highlights?.length) {
      const ul = el("ul", "experience-highlights");
      for (const h of highlights) ul.append(el("li", undefined, h));
      card.append(ul);
    }
    list.append(card);
  }
  section.append(list);
}

export function renderHobbies(section: HTMLElement) {
  const heading = sectionTitle("hobbies");
  section.append(el("h2", undefined, heading));

  const hobbies = facts.hobbies;
  if (hobbies.length === 0) return;

  const carousel = el("div", "carousel");
  carousel.setAttribute("role", "group");
  carousel.setAttribute("aria-roledescription", "carousel");
  carousel.setAttribute("aria-label", heading);

  // Scroll snapping does the actual paging, so touch swipe and trackpad
  // scrolling work without any JavaScript. The buttons below drive the same
  // scroll, which keeps one source of truth for where the carousel is.
  const track = el("div", "carousel-track");
  // The track scrolls, so it must be reachable by keyboard on its own: someone
  // navigating without a mouse has to be able to focus it and scroll with the
  // arrow keys, which the handler below listens for.
  track.tabIndex = 0;
  // A bare div cannot carry aria-label, so the focus stop is given a group
  // role; otherwise a screen reader reaches an unnamed scrollable region.
  track.setAttribute("role", "group");
  track.setAttribute("aria-label", `${heading}, use arrow keys to browse`);

  hobbies.forEach((hobby, index) => {
    // A div rather than an article: role="group" is not a valid role for
    // <article>, and the grouping semantics are what the carousel needs.
    const slide = el("div", "carousel-slide");
    slide.setAttribute("role", "group");
    slide.setAttribute("aria-roledescription", "slide");
    slide.setAttribute("aria-label", `${index + 1} of ${hobbies.length}: ${hobby.title}`);

    slide.append(mediaSlot(hobby.mediaRef, "carousel-photo"));

    const body = el("div", "carousel-text");
    body.append(el("h3", undefined, hobby.title));
    if (hobby.description) body.append(el("p", "hobby-description", hobby.description));
    slide.append(body);

    track.append(slide);
  });
  carousel.append(track);

  const controls = el("div", "carousel-controls");
  const prev = el("button", "carousel-arrow", "←") as HTMLButtonElement;
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous hobby");
  const next = el("button", "carousel-arrow", "→") as HTMLButtonElement;
  next.type = "button";
  next.setAttribute("aria-label", "Next hobby");

  const dots = el("div", "carousel-dots");
  const dotButtons = hobbies.map((hobby, index) => {
    const dot = el("button", "carousel-dot") as HTMLButtonElement;
    dot.type = "button";
    dot.setAttribute("aria-label", `Show ${hobby.title}`);
    dot.addEventListener("click", () => scrollTo(index));
    dots.append(dot);
    return dot;
  });

  controls.append(prev, dots, next);
  carousel.append(controls);
  section.append(carousel);

  let current = 0;

  function scrollTo(index: number) {
    const target = track.children[index] as HTMLElement | undefined;
    if (target) track.scrollTo({ left: target.offsetLeft - track.offsetLeft });
  }

  function sync() {
    // Nearest slide to the track's scroll position, rather than tracking
    // clicks, so swiping and scrolling stay in step with the controls.
    let nearest = 0;
    let smallest = Infinity;
    for (let i = 0; i < track.children.length; i++) {
      const child = track.children[i] as HTMLElement;
      const distance = Math.abs(child.offsetLeft - track.offsetLeft - track.scrollLeft);
      if (distance < smallest) {
        smallest = distance;
        nearest = i;
      }
    }
    current = nearest;
    dotButtons.forEach((dot, i) => {
      dot.classList.toggle("is-current", i === current);
      if (i === current) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
    prev.disabled = current === 0;
    next.disabled = current === hobbies.length - 1;
  }

  prev.addEventListener("click", () => scrollTo(current - 1));
  next.addEventListener("click", () => scrollTo(current + 1));
  track.addEventListener("scroll", sync, { passive: true });
  carousel.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowLeft") scrollTo(current - 1);
    else if (key === "ArrowRight") scrollTo(current + 1);
    else return;
    event.preventDefault();
  });

  sync();
}

export function renderFooter(section: HTMLElement) {
  section.classList.add("footer");
  section.append(el("p", "footer-name", facts.displayName ?? ""));
  if (facts.headline) section.append(el("p", "footer-headline", facts.headline));
}
