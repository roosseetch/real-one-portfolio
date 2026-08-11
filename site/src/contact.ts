import "./styles.css";
import { analyticsIdentity, identifyVisitor, initializeAnalytics, trackEvent } from "./analytics";
import { renderContactForm } from "./contact-form";
import { applyDesignTokens, renderFooterSection, renderNav } from "./shell";

/**
 * The contact page's own entry point (routes.ts, id "contact").
 *
 * A separate HTML file rather than a route inside main.ts, so /contact/ is a
 * real page: served with a 200, carrying its own title and description, and
 * readable by a link preview that never runs a line of JavaScript.
 */

/** Turnstile's own script. Loaded only where the challenge is actually rendered. */
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

interface TurnstileGlobal {
  reset(widgetId?: string): void;
}

// `|| null` rather than leaving them possibly-undefined: an unset repository
// variable reaches the build as an empty string, and an endpoint of "" is as
// unusable as one that is missing.
const workerBase = import.meta.env.VITE_WORKER_BASE_URL?.replace(/\/$/, "") || null;
const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || null;

function renderContactSection(): HTMLElement {
  const section = document.createElement("section");
  section.id = "contact";
  section.className = "section contact";

  const heading = document.createElement("h1");
  heading.textContent = "Contact";
  section.append(heading);

  const intro = document.createElement("p");
  intro.className = "contact-intro";
  intro.textContent =
    "Send me a message and it will reach me directly. Everything is read; " +
    "anything that looks like a machine wrote it is not.";
  section.append(intro);

  renderContactForm(section, {
    endpoint: workerBase === null ? null : `${workerBase}/contact`,
    siteKey,
    track: trackEvent,
    identity: analyticsIdentity,
    identify: identifyVisitor,
    // Turnstile installs itself on window once its script has loaded, and the
    // form is rendered before that happens — so this is read at reset time
    // rather than captured now.
    resetChallenge: () => (window as unknown as { turnstile?: TurnstileGlobal }).turnstile?.reset(),
  });

  return section;
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  applyDesignTokens();
  app.append(renderNav("contact"));

  const main = document.createElement("main");
  main.id = "main";
  main.tabIndex = -1;
  main.append(renderContactSection(), renderFooterSection());
  app.append(main);

  if (siteKey) {
    // After the form exists: the script renders into every .cf-turnstile it
    // finds when it loads, and one that loaded first would find nothing.
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    document.head.append(script);
  }

  initializeAnalytics();
  // The SDK autocaptures page views, but those are pooled with every other page
  // on the site. This is the one a funnel from "someone read the page" to
  // "someone wrote" can be built on, so it is named and sent on its own.
  trackEvent("contact_page_viewed", { configured: workerBase !== null && siteKey !== null });
}
