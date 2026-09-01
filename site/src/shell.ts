/**
 * The chrome every page shares: design tokens, the primary navigation, and the
 * footer.
 *
 * Extracted from main.ts when the contact page arrived. A second page with its
 * own copy of the header is a second place for a navigation change to be
 * forgotten, and the two would only diverge somewhere nobody looks.
 */
import { design, facts, portfolio } from "./profile";
import { ROUTES, routeById, routeHref } from "./routes";
import { brandMark, renderFooter } from "./sections";

/** "/" on a custom domain, "/<repo>/" on a project-pages deployment. Vite fixes it at build time. */
const BASE = import.meta.env.BASE_URL;

const HOME = routeById("home")!;

export function applyDesignTokens() {
  const palette = design.palette;
  if (!palette) return;
  const root = document.documentElement.style;
  root.setProperty("--accent", palette.accent);
  root.setProperty("--background", palette.background);
  root.setProperty("--text", palette.text);
  if (palette.surface) root.setProperty("--surface", palette.surface);
  if (palette.muted) root.setProperty("--muted", palette.muted);
}

/**
 * Primary navigation.
 *
 * The landing page's sections come from portfolio.json — labels from the
 * navigation array, positionally matched to the landing page order, falling
 * back to each section's own title so a profile without a navigation array
 * still gets a usable menu. The pages that are not the landing page come from
 * routes.ts and are appended after them.
 *
 * Section links are written against the landing page's full path rather than as
 * a bare "#about", because on any other page a bare hash points at a section
 * that is not there. A section a route claims with `landingSectionId` links to
 * that route instead of to the section.
 *
 * @param current id of the route being rendered, so it can be marked as the page the visitor is on.
 */
export function renderNav(current: string): HTMLElement {
  const header = document.createElement("header");
  header.className = "site-header";

  const skip = document.createElement("a");
  skip.className = "skip-link";
  skip.href = "#main";
  skip.textContent = "Skip to content";
  header.append(skip);

  const masthead = document.createElement("div");
  masthead.className = "masthead";

  const home = routeHref(BASE, HOME);

  // Mark and wordmark, as one link back to the top. The mark is decorative and
  // the wordmark carries the name, so the link reads as the name alone.
  const brand = document.createElement("a");
  brand.className = "brand";
  brand.href = home;
  const mark = brandMark();
  if (mark) brand.append(mark);
  brand.append(spanWith("brand-name", facts.displayName ?? ""));
  masthead.append(brand);

  const nav = document.createElement("nav");
  nav.id = "primary-nav";
  nav.className = "site-nav";
  nav.setAttribute("aria-label", "Primary");

  const targets = portfolio.landingPageOrder.filter((id) => id !== "footer");
  targets.forEach((id, index) => {
    const label = portfolio.navigation[index] ?? portfolio.sections.find((s) => s.id === id)?.title ?? id;
    // A section that has a page of its own — the landing page shows a teaser of
    // it — links to that page rather than to the teaser.
    const page = ROUTES.find((route) => route.landingSectionId === id);
    const link = navLink(page ? routeHref(BASE, page) : `${home}#${id}`, label);
    if (page?.id === current) link.setAttribute("aria-current", "page");
    nav.append(link);
  });

  for (const route of ROUTES) {
    if (route.navLabel === null) continue;
    const link = navLink(routeHref(BASE, route), route.navLabel);
    // Only on the page it points at. A screen reader announces this as "current
    // page", which is a lie anywhere else.
    if (route.id === current) link.setAttribute("aria-current", "page");
    nav.append(link);
  }

  masthead.append(navToggle(nav), nav);
  header.append(masthead);
  return header;
}

function spanWith(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

/**
 * The narrow-screen disclosure.
 *
 * Six uppercase items do not fit one 390px line, so below the breakpoint the
 * menu collapses behind this and the stylesheet hides the panel. Hidden with
 * `display`, not with opacity or an offset: a menu that is merely invisible is
 * still in the tab order, and a keyboard reaches a control nobody can see.
 *
 * The button itself is the reverse — it exists in the markup at every width and
 * the stylesheet removes it above the breakpoint, so there is no resize handler
 * and nothing to get out of step with the layout.
 */
function navToggle(nav: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nav-toggle";
  button.setAttribute("aria-controls", nav.id);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Menu");
  button.append(hamburger());

  const setOpen = (open: boolean) => {
    button.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
  };

  button.addEventListener("click", () => {
    setOpen(button.getAttribute("aria-expanded") !== "true");
  });

  // Escape closes it and hands focus back to the control that opened it —
  // otherwise focus is left inside an element that has just been hidden, and
  // the next Tab starts again from the top of the document.
  nav.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    setOpen(false);
    button.focus();
  });
  button.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    setOpen(false);
  });

  // A link that jumps to a section on this same page leaves the panel covering
  // the thing it just jumped to.
  nav.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("a")) setOpen(false);
  });

  return button;
}

/** Three rules. Drawn rather than typed, because "☰" is a character a font may not have. */
function hamburger(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 7h18M3 12h18M3 17h18");
  svg.append(path);
  return svg;
}

function navLink(href: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "nav-link";
  link.href = href;
  link.textContent = label;
  return link;
}

/** The footer, as a section, for pages that do not build one from landingPageOrder. */
export function renderFooterSection(): HTMLElement {
  const section = document.createElement("section");
  section.id = "footer";
  section.className = "section";
  renderFooter(section);
  return section;
}
