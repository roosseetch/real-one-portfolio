/**
 * The chrome every page shares: design tokens, the primary navigation, and the
 * footer.
 *
 * Extracted from main.ts when the contact page arrived. A second page with its
 * own copy of the header is a second place for a navigation change to be
 * forgotten, and the two would only diverge somewhere nobody looks.
 */
import { design, portfolio } from "./profile";
import { ROUTES, routeById, routeHref } from "./routes";
import { renderFooter } from "./sections";

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

  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Primary");

  const home = routeHref(BASE, HOME);
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

  header.append(nav);
  return header;
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
