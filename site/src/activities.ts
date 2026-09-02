import "./styles.css";
import {
  activitiesHref,
  activityHref,
  el,
  longArrow,
  mountFeed,
  note,
  renderRecord,
  selectRecords,
  sortRecords,
  type ActivityRecord,
} from "./activity";
import { initializeAnalytics, trackEvent } from "./analytics";
import { facts, portfolio } from "./profile";
import { applyDesignTokens, renderFooterSection, renderNav } from "./shell";

/**
 * The activities page's own entry point (routes.ts, id "activities").
 *
 * Two views, one built file. `/activities/` lists every published record under
 * the feed's own heading; `/activities/?v=<slug>` shows one of them on its own,
 * headed by that record's title, which is the link a record can be shared or
 * referred to by.
 *
 * The single view is a query parameter rather than a path of its own because a
 * record published five minutes ago has no built file and never will: the site
 * is static and the feed is fetched in the browser. One page that reads `?v=`
 * at load time is a page Pages answers with a 200 whatever it names, where
 * /activities/morning-run/ would be a 404 for every record.
 *
 * Navigation between the two is ordinary links and full page loads. Nothing
 * here touches history — see the header comment in routes.ts for why the whole
 * site is built that way.
 */

export interface ActivitiesOptions {
  /** Analytics sink, injected so the suite can drive this without an SDK. */
  track?: (eventType: string, properties?: Record<string, unknown>) => void;
}

const SECTION_TITLE = portfolio.sections.find((s) => s.id === "activity")?.title ?? "Recent Activities";

function backLink(): HTMLAnchorElement {
  const link = el("a", "activity-back label") as HTMLAnchorElement;
  link.href = activitiesHref();
  link.append(longArrow(true, 34), document.createTextNode("All activities"));
  return link;
}

/**
 * The record before and after this one, at the foot of its page.
 *
 * The list is newest first, so the record after this one in it is the older
 * one. Either may be missing — at the ends of the feed — and a missing
 * neighbour is no link rather than a disabled one.
 */
function neighbourLinks(records: ActivityRecord[], current: ActivityRecord): HTMLElement | null {
  const ordered = sortRecords(records, false);
  const index = ordered.findIndex((candidate) => candidate.id === current.id);
  if (index === -1) return null;

  const neighbours: Array<[string, ActivityRecord | undefined]> = [
    ["Older", ordered[index + 1]],
    ["Newer", ordered[index - 1]],
  ];

  const nav = el("nav", "activity-neighbours");
  nav.setAttribute("aria-label", "More activities");
  for (const [label, record] of neighbours) {
    if (!record) continue;
    const link = el("a", "activity-neighbour") as HTMLAnchorElement;
    link.href = activityHref(record);
    link.append(el("span", "activity-neighbour-label label", label));
    link.append(el("span", "activity-neighbour-title", record.title));
    nav.append(link);
  }
  return nav.childElementCount > 0 ? nav : null;
}

/**
 * The sort control's direction mark. It is drawn pointing down, for newest
 * first, and turned over by CSS when the order is; the outermost `<svg>` is the
 * one element a `transform` attribute does not reliably move.
 */
function sortArrow(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "activity-sort-arrow");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", "9");
  svg.setAttribute("height", "9");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.1");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M6 1v10M2 7l4 4 4-4");
  svg.append(path);
  return svg;
}

/**
 * Every record, newest first, each title a link to its own page.
 *
 * The text is cut to an excerpt here. A list is for finding the activity you
 * want, and one note long enough to fill the screen pushes every record under it
 * off the bottom of it; the whole text is a click away, on the page the excerpt
 * links to.
 */
function renderList(section: HTMLElement, list: HTMLElement, records: ActivityRecord[]) {
  let ascending = false;

  const paint = () => {
    list.replaceChildren(
      ...sortRecords(records, ascending).map((record) =>
        renderRecord(record, { href: activityHref(record), excerpt: true }),
      ),
    );
  };

  const toggle = el("button", "activity-sort label") as HTMLButtonElement;
  toggle.type = "button";
  const state = el("span", "activity-sort-state");
  toggle.append(state, sortArrow());

  // The label names the order on screen rather than the one a press would
  // produce. Naming the press was shorter, but it left the reader deciding
  // which of the two the words meant, and the list itself is the only place
  // that answer was written down.
  const describe = () => {
    state.textContent = ascending ? "Sorted: Oldest first" : "Sorted: Newest first";
    toggle.dataset.order = ascending ? "ascending" : "descending";
    // The visible words open the accessible name, so a reader who speaks them
    // to a voice control names the same button (WCAG 2.5.3), and what the press
    // does is said out loud rather than left to the arrow.
    toggle.setAttribute(
      "aria-label",
      `${state.textContent}. Press to sort ${ascending ? "newest" : "oldest"} first.`,
    );
  };

  toggle.addEventListener("click", () => {
    ascending = !ascending;
    describe();
    paint();
  });
  describe();

  // A hairline running out from the heading to the control, which is how the
  // design separates the page's title from its list.
  const head = el("div", "activity-list-head");
  const rule = el("div", "rule");
  rule.setAttribute("aria-hidden", "true");
  head.append(rule, toggle);
  section.insertBefore(head, list);
  paint();
}

/**
 * What `?v=` named: one record, the several that share its slug, or nothing.
 *
 * Several is not a failure. A slug comes from a title and two activities can be
 * titled alike, so the honest answer is both of them rather than an arbitrary
 * one of them.
 */
function renderSelection(
  section: HTMLElement,
  list: HTMLElement,
  records: ActivityRecord[],
  value: string,
  options: ActivitiesOptions,
) {
  const matches = selectRecords(records, value);

  if (matches.length === 0) {
    // There is no activity to head this page with, and the feed's own title
    // would say the visitor is looking at a list that is not there either.
    section.insertBefore(backLink(), list);
    section.insertBefore(el("h1", undefined, "Activity not found"), list);
    note(section, "That activity is not here. It may have been removed since the link was made.");
    // Worth its own event: a permalink that resolves to nothing is either a
    // record that was unpublished or a link built wrong, and neither shows up
    // in a page-view count.
    options.track?.("activity_not_found", { v: value });
    return;
  }

  if (matches.length > 1) {
    section.insertBefore(
      el("p", "activity-note", `${matches.length} activities share this name.`),
      list,
    );
  } else {
    // So a bookmark, a tab, and a browser's history say which activity this is.
    // Only the title: the description and social metadata were written into this
    // page's HTML at build time, before any record existed to describe.
    document.title = `${matches[0].title} — ${facts.displayName ?? "Portfolio"}`;
  }

  // At the top, where the design puts it: on a page reached from a link, the
  // way back to the list is a place to start rather than something to find
  // after reading everything.
  section.insertBefore(backLink(), list);

  list.classList.add("activity-single");
  // The record's own title is this page's heading. No href on it either: it
  // would link this page to itself.
  list.replaceChildren(...matches.map((record) => renderRecord(record, { heading: "h1" })));

  if (matches.length === 1) {
    const neighbours = neighbourLinks(records, matches[0]);
    if (neighbours) section.append(neighbours);
  }
}

/**
 * The activities section, in whichever of its views `search` asks for.
 *
 * The search string is a parameter rather than read from location here, so any
 * view can be rendered without a page having to be at that URL.
 */
export function renderActivitiesSection(search: string, options: ActivitiesOptions = {}): HTMLElement {
  const section = document.createElement("section");
  section.id = "activities";
  section.className = "section activities";

  const selected = new URLSearchParams(search).get("v");

  // "Recent Activities" heads the list of them. A page showing one is headed by
  // that activity's own title instead — it is what the tab, a bookmark and a
  // link preview already call this page, and a heading naming the whole feed
  // above a single record says the visitor is somewhere they are not.
  if (selected === null) section.append(el("h1", undefined, SECTION_TITLE));

  const list = el("div", "activity-list");
  section.append(list);

  mountFeed(section, selected === null ? 3 : 1, (records) => {
    if (selected === null) renderList(section, list, records);
    else renderSelection(section, list, records, selected, options);
  });

  return section;
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  applyDesignTokens();
  app.append(renderNav("activities"));

  const main = document.createElement("main");
  main.id = "main";
  main.tabIndex = -1;
  main.append(renderActivitiesSection(location.search, { track: trackEvent }), renderFooterSection());
  app.append(main);

  initializeAnalytics();
  // The SDK autocaptures page views, but a visit to one activity and a visit to
  // the whole list are the same URL to it. Which of the two this was is the
  // thing worth counting here.
  trackEvent("activities_page_viewed", {
    view: new URLSearchParams(location.search).get("v") === null ? "list" : "single",
  });
}
