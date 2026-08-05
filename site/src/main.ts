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

function renderShell(app: HTMLElement) {
  const main = document.createElement("main");
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
  initializeAnalytics();
}
