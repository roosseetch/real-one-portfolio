import { facts, personality, portfolio, mediaRef, profileLinks } from "./profile";
import { routeById, routeHref } from "./routes";

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

/** "/" on a custom domain, "/<repo>/" on a project-pages deployment. */
const BASE = import.meta.env.BASE_URL;

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

/**
 * The mark in the masthead, or nothing.
 *
 * From the media bucket rather than from `public/`, exactly as head.ts serves
 * the favicon and for the same reason: a logo is one person's brand mark, and a
 * repository meant to be reused for someone else carries no images at all
 * (spec §1). A build with no media base therefore shows the wordmark on its own,
 * which is a masthead with one element missing rather than a broken one.
 *
 * A deployment whose media pipeline has not published a mark yet gets the same
 * outcome by a different route: the request 404s and the element takes itself
 * out of the masthead. An `alt=""` image that failed to load is invisible in
 * most browsers and a broken-image glyph in some, and neither is worth leaving
 * to chance beside a wordmark that is already complete without it.
 *
 * Here rather than in shell.ts because this module is where MEDIA_BASE and the
 * rules about it already live.
 */
export function brandMark(): HTMLImageElement | null {
  if (!MEDIA_BASE) return null;
  const img = new Image();
  img.className = "brand-mark";
  // Named for its width, as the other profile media is, and that is what makes
  // it safe to redraw: the objects here are uploaded to a stable key with a
  // week of cache behind them, so replacing mark.png in place left the CDN
  // serving the old one and no token to hand could purge it. A new width is a
  // new name is a new object, which every reader gets at once.
  img.src = `${MEDIA_BASE}/media/profile/mark-730.png`;
  // The wordmark beside it says the name, so the mark adds nothing to say.
  img.alt = "";
  img.decoding = "async";
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}

function sectionTitle(id: string): string {
  return portfolio.sections.find((s) => s.id === id)?.title ?? id;
}

/**
 * A section's heading and the short gold rule under it, in the narrow column
 * the design gives all three of About, Experience and Hobbies.
 */
export function sectionHead(title: string, extra?: HTMLElement): HTMLElement {
  const head = el("div", "column-head");
  head.append(el("h2", undefined, title));
  const rule = el("div", "rule-accent");
  rule.setAttribute("aria-hidden", "true");
  head.append(rule);
  if (extra) head.append(extra);
  return head;
}

/**
 * The opening band: warm gradient, the portrait tipped into its left, and the
 * greeting beside it.
 *
 * Full-bleed, so it breaks out of the `.section` frame main.ts gives it and
 * carries its own inner measure — the gradient is the width of the window in
 * the design, and a hero inset by the page gutter is a different composition.
 *
 * The design has no call-to-action buttons. "Discover my story" and "See recent
 * activities" pointed at two things the navigation already names one line above,
 * so they are gone rather than restyled.
 */
export function renderHero(section: HTMLElement) {
  section.classList.add("hero");
  const intro = personality.aboutText?.split("\n\n")[0] ?? "";

  const band = el("div", "hero-band");
  // Two washes of light over the gradient and the grain over both. Decorative
  // in the strict sense — remove all three and nothing has been said less.
  for (const layer of ["hero-bloom", "hero-glow", "hero-grain"]) {
    const node = el("div", layer);
    node.setAttribute("aria-hidden", "true");
    band.append(node);
  }

  const inner = el("div", "hero-inner");

  const plate = el("div", "hero-plate plate");
  plate.append(mediaSlot("hero", "hero-portrait"));

  const text = el("div", "hero-text");
  text.append(el("h1", "hero-title", sectionTitle("hero")));
  const rule = el("div", "hero-rule");
  rule.setAttribute("aria-hidden", "true");
  text.append(rule);
  text.append(el("p", "hero-intro prose", intro));

  inner.append(plate, text);
  band.append(inner);
  section.append(band);
}

/**
 * Heading in a narrow left column, prose in a wide right one.
 *
 * The first paragraph is set larger than the rest: it is the one that has to be
 * read, and the design leans on size rather than on a bold weight to say so —
 * which is just as well, since Lora ships at 400 only.
 */
export function renderAbout(section: HTMLElement) {
  section.append(sectionHead(sectionTitle("about")));

  const body = el("div", "column-body");
  const paragraphs = (personality.aboutText ?? "").split("\n\n").filter(Boolean);
  paragraphs.forEach((paragraph, index) => {
    body.append(el("p", index === 0 ? "about-lead prose" : "about-paragraph prose", paragraph));
  });
  section.append(body);
  section.classList.add("column-section");
}

/**
 * One entry on the timeline, whichever of the two lists it came from.
 *
 * `sortKey` is what merges them. Work carries `start` as `YYYY-MM` and education
 * carries `year` alone, and both begin with the same four digits — so a plain
 * string comparison orders the merged list correctly without either being
 * padded into a date it does not have.
 */
interface Milestone {
  kind: "work" | "study";
  sortKey: string;
  /** Uppercase line above the title: a range for work, a bare year for study. */
  when: string;
  title: string;
  /** Employer, or awarding institution. */
  where?: string;
  summary?: string;
  highlights?: readonly string[];
}

function milestones(): Milestone[] {
  const work: Milestone[] = facts.experience.map((job) => ({
    kind: "work",
    sortKey: job.start ?? "",
    when: [formatDate(job.start), formatDate(job.end)].filter(Boolean).join(" \u2014 "),
    title: job.title,
    where: job.organization,
    summary: job.summary,
    highlights: "highlights" in job ? job.highlights : undefined,
  }));

  const study: Milestone[] = facts.education.map((award) => ({
    kind: "study",
    sortKey: award.year ?? "",
    // The artboards date these to the month — "December 2018", "April 2013" —
    // and the profile records the year alone. A month that is not in the data
    // is not a month this may invent, so a bare year is what is set.
    when: award.year ?? "",
    title: award.degree,
    where: award.institution,
  }));

  return [...work, ...study].sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

/**
 * Work and study against one spine, newest first.
 *
 * Two lists in the profile and one chronology in the reader's head: a role
 * begun the year a doctorate finished says something that two separate lists,
 * each sorted on its own, cannot. Work sits left of the spine under a filled
 * ink square, study right of it under a hollow gold circle, and below 48rem the
 * whole thing folds onto a single left rail because two 190px columns are not
 * two columns.
 *
 * The side of the spine and the shape of the marker are the only things saying
 * which list an entry came from, and neither reaches a screen reader — so each
 * entry also carries the word, set where only a reader that cannot see the
 * shape will meet it.
 */
export function renderExperience(section: HTMLElement) {
  section.classList.add("column-section");

  const legend = el("ul", "timeline-legend");
  for (const [kind, label] of [
    ["work", "Work"],
    ["study", "Education \u0026 certification"],
  ] as const) {
    const item = el("li", `timeline-legend-item is-${kind}`);
    const marker = el("span", "timeline-marker");
    marker.setAttribute("aria-hidden", "true");
    item.append(marker, el("span", "label", label));
    legend.append(item);
  }
  section.append(sectionHead(sectionTitle("experience"), legend));

  const list = el("ol", "timeline");
  for (const milestone of milestones()) {
    const entry = el("li", `timeline-entry is-${milestone.kind}`);

    const marker = el("span", "timeline-marker");
    marker.setAttribute("aria-hidden", "true");
    entry.append(marker);

    const card = el("div", "timeline-card");
    const when = el("div", "timeline-when label tnum");
    when.append(
      el("span", "visually-hidden", milestone.kind === "work" ? "Work. " : "Education. "),
      document.createTextNode(milestone.when),
    );
    card.append(when);
    card.append(el("h4", undefined, milestone.title));
    if (milestone.where) card.append(el("div", "timeline-where", milestone.where));
    if (milestone.summary) card.append(el("p", "timeline-summary", milestone.summary));
    if (milestone.highlights?.length) {
      const ul = el("ul", "timeline-highlights");
      for (const highlight of milestone.highlights) ul.append(el("li", undefined, highlight));
      card.append(ul);
    }

    entry.append(card);
    list.append(entry);
  }
  section.append(list);
}

/**
 * One hobby at a time, chosen from a named rail.
 *
 * This replaces a scroll-snap carousel with arrows and dots. The carousel asked
 * the reader to page blindly through four things to find out what they were;
 * the rail names all four and goes straight to one, which is what a set of four
 * fixed, unordered items wants. The keyboard contract is the ARIA tabs one:
 * arrows move between tabs, Home and End jump to the ends, and only the
 * selected tab is in the tab order, so Tab leaves the rail rather than walking
 * it.
 *
 * The kicker and the display line come apart when the profile gives a hobby a
 * `headline` — "Ballet" above "At the barre", as the design sets it. Without
 * one there is no kicker and the title is the heading, because a headline is
 * someone's own words about their own hobby and is not something to invent.
 */
export function renderHobbies(section: HTMLElement) {
  const heading = sectionTitle("hobbies");
  section.classList.add("column-section");
  section.append(sectionHead(heading));

  const hobbies = facts.hobbies;
  if (hobbies.length === 0) return;

  const body = el("div", "column-body hobbies");

  const rail = el("div", "hobby-rail");
  rail.setAttribute("role", "tablist");
  rail.setAttribute("aria-label", heading);

  const tabs: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];

  hobbies.forEach((hobby, index) => {
    const tabId = `hobby-tab-${hobby.id}`;
    const panelId = `hobby-panel-${hobby.id}`;

    const tab = el("button", "hobby-tab label", hobby.title) as HTMLButtonElement;
    tab.type = "button";
    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    tabs.push(tab);
    rail.append(tab);

    const panel = el("div", "hobby-panel");
    panel.id = panelId;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabId);

    const text = el("div", "hobby-text");
    const headline = (hobby as { headline?: string | null }).headline;
    if (headline) {
      text.append(el("div", "hobby-kicker label", hobby.title));
      text.append(el("h3", undefined, headline));
    } else {
      text.append(el("h3", undefined, hobby.title));
    }
    if (hobby.description) text.append(el("p", "hobby-description prose", hobby.description));

    const plate = el("div", "hobby-plate plate");
    plate.append(mediaSlot(hobby.mediaRef, "hobby-photo"));

    panel.append(text, plate);
    panels.push(panel);
    body.append(panel);

    tab.addEventListener("click", () => select(index));
  });

  body.append(rail);
  section.append(body);

  let current = 0;

  function select(index: number, moveFocus = false) {
    current = index;
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", String(selected));
      // Roving tabindex: one stop for the whole rail, so Tab moves past it
      // rather than through every hobby.
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    // A lazy image inside a panel that was `display: none` when it was parsed
    // is never fetched, and revealing the panel does not start it — three of
    // the four hobbies showed an empty plate on the live site for exactly this
    // reason. Asking for it eagerly at the moment it is shown is what starts
    // the request, and it keeps the other three unfetched until they are asked
    // for, which is what lazy was there for.
    panels[index].querySelector("img")?.setAttribute("loading", "eager");
    if (moveFocus) tabs[index].focus();
  }

  rail.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    const last = tabs.length - 1;
    let next: number;
    if (key === "ArrowRight" || key === "ArrowDown") next = current === last ? 0 : current + 1;
    else if (key === "ArrowLeft" || key === "ArrowUp") next = current === 0 ? last : current - 1;
    else if (key === "Home") next = 0;
    else if (key === "End") next = last;
    else return;
    event.preventDefault();
    select(next, true);
  });

  select(0);
}

/**
 * LinkedIn's mark, drawn rather than fetched.
 *
 * Inline because the alternative is a request to somewhere for a 500-byte
 * glyph: an image in the repository, which this one deliberately has none of, or
 * a third-party CDN, which would tell LinkedIn about every visitor to a page
 * they never clicked. The path is the mark as LinkedIn publishes it, in a 24×24
 * box, and `currentColor` lets the stylesheet own what shade it is.
 */
function linkedInMark(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "currentColor");
  // The icon says nothing the link's own label does not, and a screen reader
  // announcing "image" before "LinkedIn" is one word of noise.
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z",
  );

  svg.append(path);
  return svg;
}

/**
 * Where a LinkedIn handle lives.
 *
 * Here rather than in the profile, and that is the whole reason the profile
 * stores `dina-haman-b52b8716b` and not the address it sits at: an absolute URL
 * and a domain in profile content is exactly what validate-profile.ts refuses,
 * because a reusable repository's profile has no business naming hosts. In
 * tracked source linkedin.com is something else entirely — a third-party service
 * the code genuinely calls, which is why it is already an allowed host in
 * scripts/no-deployment-values.test.ts.
 */
const LINKEDIN_PROFILE = "https://www.linkedin.com/in/";

/**
 * The link itself, or nothing.
 *
 * The handle is checked against the same character class the schema pins it to,
 * a second time. The profile is fetched from a bucket at build time rather than
 * read out of the repository, so what reaches this function is not what a
 * validator saw — and a "handle" carrying a colon or a slash would not be a
 * handle, it would be an address of the caller's choosing pasted into an href.
 */
export function linkedInLink(handle: string | undefined): HTMLAnchorElement | null {
  if (!handle || !/^[A-Za-z0-9-]{1,100}$/.test(handle)) return null;

  const link = document.createElement("a");
  link.className = "footer-social";
  link.href = `${LINKEDIN_PROFILE}${handle}`;
  // The accessible name, since the only child is a decorative glyph.
  link.setAttribute("aria-label", "LinkedIn");
  link.rel = "noopener noreferrer me";
  link.target = "_blank";
  link.append(linkedInMark());

  return link;
}

/**
 * One ranged line: an invitation on the left, the LinkedIn mark beside it, and
 * the year and place pushed to the right.
 *
 * The name and headline that used to sit here are gone. They are the first two
 * things the page says at full size, and repeating them in 9.5px grey at the
 * bottom was a summary of a page the reader has just finished.
 *
 * The place comes from the profile, which says "Aargau, Switzerland". The
 * artboards say Basel; that is placeholder text in a mock-up, and the profile is
 * the one that knows.
 */
export function renderFooter(section: HTMLElement) {
  section.classList.add("footer");

  const row = el("div", "footer-row");

  const contact = routeById("contact");
  if (contact) {
    const invite = el("a", "footer-invite label", "Let\u2019s stay connected") as HTMLAnchorElement;
    invite.href = routeHref(BASE, contact);
    row.append(invite);
  }

  const linkedin = linkedInLink(profileLinks().linkedin);
  if (linkedin !== null) row.append(linkedin);

  const year = new Date().getFullYear();
  const place = facts.location ? ` \u00b7 ${facts.location}` : "";
  row.append(el("span", "footer-meta label tnum", `\u00a9 ${year}${place}`));

  section.append(row);
}
