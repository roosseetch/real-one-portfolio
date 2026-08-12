/**
 * Every page the built site emits, in one place.
 *
 * Two readers need this list and neither can derive it from the other:
 * vite.config.ts turns each `entry` into a Rollup input and a per-page title,
 * and the browser turns each `path` into a link in the primary navigation.
 * Declared in only one of them, a page is either a file nothing links to or a
 * link to a file that was never built.
 *
 * This is the whole router, and it is deliberately not a router in the
 * single-page sense. Every path here is a real directory with its own
 * index.html, which GitHub Pages serves with a 200 and with that page's own
 * title and description. Intercepting history and falling back through 404.html
 * would have had /contact answered with a 404 status on first load — which is
 * what a search engine and a link preview read, whatever the page then renders.
 */

export interface Route {
  /** Stable identifier, used to mark the page a visitor is already on. */
  id: string;
  /**
   * Path below the site's base, with a trailing slash so Pages serves the
   * directory's index.html. Empty is the landing page. Never absolute: the base
   * is "/" on a custom domain and "/<repo>/" on a project-pages deployment, and
   * only the build knows which.
   */
  path: string;
  /** Build input, relative to site/. */
  entry: string;
  /**
   * Primary-navigation label. Null for the landing page, whose own navigation
   * is built from the profile's section titles rather than from this file, and
   * null for a page that `landingSectionId` already gives an entry.
   */
  navLabel: string | null;
  /**
   * The landing-page section this page is the full version of.
   *
   * That section already has a navigation entry, labelled from the profile, and
   * a second entry for the page would leave the menu with two near-identical
   * items. Declaring the section here sends its existing entry to this page
   * instead.
   */
  landingSectionId?: string;
  /**
   * What this page's <title> says ahead of the profile's name. Null keeps the
   * profile's title exactly as the landing page has it.
   */
  title: string | null;
  /** This page's description meta. Null falls back to the profile's opening paragraph. */
  description: string | null;
}

export const ROUTES: Route[] = [
  {
    id: "home",
    path: "",
    entry: "index.html",
    navLabel: null,
    title: null,
    description: null,
  },
  {
    id: "activities",
    path: "activities/",
    entry: "activities/index.html",
    navLabel: null,
    landingSectionId: "activity",
    title: "Recent Activities",
    description: "Everything I have published, most recent first.",
  },
  {
    id: "contact",
    path: "contact/",
    entry: "contact/index.html",
    navLabel: "Contact",
    title: "Contact",
    description: "Send me a message.",
  },
];

export function routeById(id: string): Route | undefined {
  return ROUTES.find((route) => route.id === id);
}

/**
 * A route's absolute path, given the base the site was built with.
 *
 * The base arrives as an argument rather than being read from
 * `import.meta.env` here, because vite.config.ts imports this module in Node,
 * where that object does not exist.
 */
export function routeHref(base: string, route: Route): string {
  return `${base.replace(/\/*$/, "/")}${route.path}`;
}
