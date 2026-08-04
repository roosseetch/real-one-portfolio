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

/** Image slot for media that only becomes public after the sanitization
    pipeline runs (Phase 5). Until then it renders an accent-tinted block
    carrying the alt text, so layout and accessibility are already real. */
function mediaSlot(refId: string | null, className: string): HTMLElement {
  const ref = refId ? mediaRef(refId) : null;
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
  section.append(el("h2", undefined, sectionTitle("hobbies")));
  const grid = el("div", "hobby-grid");
  for (const hobby of facts.hobbies) {
    const card = el("article", "hobby-card");
    card.append(mediaSlot(hobby.mediaRef, "hobby-photo"));
    card.append(el("h3", undefined, hobby.title));
    if (hobby.description) card.append(el("p", "hobby-description", hobby.description));
    grid.append(card);
  }
  section.append(grid);
}

export function renderFooter(section: HTMLElement) {
  section.classList.add("footer");
  section.append(el("p", "footer-name", facts.displayName ?? ""));
  if (facts.headline) section.append(el("p", "footer-headline", facts.headline));
}
