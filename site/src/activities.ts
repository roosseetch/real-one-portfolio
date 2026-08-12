import "./styles.css";
import {
  activitiesHref,
  activityHref,
  el,
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
 * Two views, one built file. `/activities/` lists every published record;
 * `/activities/?v=<slug>` shows one of them on its own, which is the link a
 * record can be shared or referred to by.
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
  const link = el("a", "activity-back", "← All activities") as HTMLAnchorElement;
  link.href = activitiesHref();
  return link;
}

/** Every record, newest first, each title a link to its own page. */
function renderList(section: HTMLElement, list: HTMLElement, records: ActivityRecord[]) {
  let ascending = false;

  const paint = () => {
    list.replaceChildren(
      ...sortRecords(records, ascending).map((record) => renderRecord(record, { href: activityHref(record) })),
    );
  };

  const toggle = el("button", "activity-sort", "Oldest first") as HTMLButtonElement;
  toggle.addEventListener("click", () => {
    ascending = !ascending;
    toggle.textContent = ascending ? "Newest first" : "Oldest first";
    paint();
  });
  section.insertBefore(toggle, list);
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
    note(section, "That activity is not here. It may have been removed since the link was made.");
    section.append(backLink());
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

  list.classList.add("activity-single");
  // No href on the title: it would link this page to itself.
  list.replaceChildren(...matches.map((record) => renderRecord(record, { heading: "h2" })));
  section.append(backLink());
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

  section.append(el("h1", undefined, SECTION_TITLE));

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
