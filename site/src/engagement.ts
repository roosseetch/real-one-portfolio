/**
 * Amplitude reports a session's length as the gap between its first and last
 * event. This site used to emit everything it had within a few milliseconds of
 * load—session start, one page view, attribution—so every visitor who did not
 * reload showed up as a 0s session no matter how long they actually read.
 *
 * These handlers exist to put a truthful timestamp at the *end* of a visit. The
 * design is deliberately bounded rather than a periodic heartbeat: ad-blocked
 * visitors fall back to the Worker relay, and a heartbeat would bill one Worker
 * invocation per interval for the whole visit. What follows is at most four
 * scroll milestones plus a summary as the visitor leaves.
 */

const SCROLL_MILESTONES = [25, 50, 75, 100] as const;

/** A tab flipper must not be able to bill a summary per flip. */
const MIN_INTERIM_REPORT_GAP_SECONDS = 5;

export interface EngagementSink {
  /** Records one engagement event. */
  track(eventType: string, properties: Record<string, unknown>): void;
  /**
   * Called once as the page unloads, before the final event, so the caller can
   * switch to a transport that survives unload.
   */
  leaving(): void;
  /** Sends everything queued, immediately. */
  flush(): void;
}

/** Percentage of the document that has passed through the viewport. */
function scrollDepth(): number {
  const doc = document.documentElement;
  // A page shorter than the viewport has been seen in full the moment it loads.
  if (doc.scrollHeight <= window.innerHeight) return 100;
  const seen = ((window.scrollY + window.innerHeight) / doc.scrollHeight) * 100;
  return Math.max(0, Math.min(100, Math.round(seen)));
}

export function trackEngagement(sink: EngagementSink): void {
  const sectionsSeen = new Set<string>();
  const milestonesSent = new Set<number>();
  let maxDepth = 0;

  // Engaged time counts only while the tab is actually on screen, so a page
  // left open in a background tab overnight does not report as an all-nighter.
  let engagedMs = 0;
  let visibleSince: number | null = document.visibilityState === "visible" ? Date.now() : null;
  let reportedSeconds = -1;

  function settle() {
    if (visibleSince === null) return;
    engagedMs += Date.now() - visibleSince;
    visibleSince = null;
  }

  function recordDepth() {
    const depth = scrollDepth();
    if (depth > maxDepth) maxDepth = depth;
    for (const milestone of SCROLL_MILESTONES) {
      if (maxDepth < milestone || milestonesSent.has(milestone)) continue;
      milestonesSent.add(milestone);
      sink.track("page_scrolled", { percent: milestone });
    }
    // Nothing left to detect once the last milestone is out.
    if (milestonesSent.size === SCROLL_MILESTONES.length) {
      window.removeEventListener("scroll", onScroll);
    }
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      recordDepth();
    });
  }

  /** Returns whether a summary was recorded. */
  function report(final: boolean): boolean {
    settle();
    const seconds = Math.round(engagedMs / 1000);
    if (final ? seconds === reportedSeconds : seconds - reportedSeconds < MIN_INTERIM_REPORT_GAP_SECONDS) {
      return false;
    }
    reportedSeconds = seconds;
    sink.track("page_engaged", {
      engaged_seconds: seconds,
      max_scroll_percent: maxDepth,
      sections_seen: [...sectionsSeen],
    });
    return true;
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  recordDepth();

  // A section taller than the viewport can never reach a 50% intersection
  // ratio, so accept either half the section or half the screen.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (!id || sectionsSeen.has(id)) continue;
        const half = entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= window.innerHeight * 0.5;
        if (!half) continue;
        sectionsSeen.add(id);
        observer.unobserve(entry.target);
      }
    },
    { threshold: [0, 0.5] },
  );
  for (const section of document.querySelectorAll<HTMLElement>("main .section[id]")) {
    observer.observe(section);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (visibleSince === null) visibleSince = Date.now();
      return;
    }
    // Mobile browsers can discard a hidden tab without ever firing pagehide,
    // so treat going hidden as a chance to bank what is known so far.
    if (report(false)) sink.flush();
  });

  window.addEventListener("pagehide", () => {
    sink.leaving();
    report(true);
    sink.flush();
  });

  // Back-forward cache: pagehide already ran but the page was frozen rather
  // than torn down, so restart the clock for the next stretch of reading.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    if (visibleSince === null && document.visibilityState === "visible") visibleSince = Date.now();
  });
}
