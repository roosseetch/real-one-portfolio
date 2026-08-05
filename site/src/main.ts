import "./styles.css";
import { initializeAnalytics } from "./analytics";
import { facts, design, portfolio } from "./profile";
import { renderHero, renderAbout, renderExperience, renderHobbies, renderFooter } from "./sections";
import { renderActivity } from "./activity";

const SECTION_RENDERERS: Record<string, (section: HTMLElement) => void> = {
  hero: renderHero,
  about: renderAbout,
  experience: renderExperience,
  hobbies: renderHobbies,
  activity: (section) =>
    renderActivity(section, portfolio.sections.find((s) => s.id === "activity")?.title ?? "Recent Activities"),
  footer: renderFooter
};

function applyDesignTokens() {
  const palette = design.palette;
  if (!palette) return;
  const root = document.documentElement.style;
  root.setProperty("--accent", palette.accent);
  root.setProperty("--background", palette.background);
  root.setProperty("--text", palette.text);
  if (palette.surface) root.setProperty("--surface", palette.surface);
  if (palette.muted) root.setProperty("--muted", palette.muted);
}

/** Primary navigation, built from portfolio.json. Labels come from the
    navigation array, positionally matched to the landing page order, and fall
    back to each section's own title so a profile without a navigation array
    still gets a usable menu. */
function renderNav(): HTMLElement {
  const header = document.createElement("header");
  header.className = "site-header";

  const skip = document.createElement("a");
  skip.className = "skip-link";
  skip.href = "#main";
  skip.textContent = "Skip to content";
  header.append(skip);

  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Primary");

  const targets = portfolio.landingPageOrder.filter((id) => id !== "footer");
  targets.forEach((id, index) => {
    const label = portfolio.navigation[index] ?? portfolio.sections.find((s) => s.id === id)?.title ?? id;
    const link = document.createElement("a");
    link.className = "nav-link";
    link.href = `#${id}`;
    link.textContent = label;
    nav.append(link);
  });

  header.append(nav);
  return header;
}

function renderShell(app: HTMLElement) {
  app.append(renderNav());
  const main = document.createElement("main");
  main.id = "main";
  main.tabIndex = -1;
  for (const id of portfolio.landingPageOrder) {
    const section = document.createElement("section");
    section.id = id;
    section.className = "section";
    const render = SECTION_RENDERERS[id];
    if (render) {
      render(section);
    } else {
      const title = portfolio.sections.find((s) => s.id === id)?.title ?? id;
      section.innerHTML = `<div class="placeholder">${title}</div>`;
    }
    main.append(section);
  }
  app.append(main);
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  document.title = facts.displayName ?? "Portfolio";
  applyDesignTokens();
  renderShell(app);

  // The browser resolves the hash before these sections exist, so a shared
  // link such as /#about would otherwise open at the top of the page. Jump
  // instantly rather than smoothly, and again once images have loaded, because
  // a smooth scroll cannot land on a target that is still moving down the page.
  if (location.hash.length > 1) {
    const id = location.hash.slice(1);
    const jump = () => document.getElementById(id)?.scrollIntoView({ behavior: "instant" });
    jump();
    window.addEventListener("load", jump, { once: true });
  }
  initializeAnalytics();
}
