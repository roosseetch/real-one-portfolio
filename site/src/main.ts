import "./styles.css";
import { facts, design, portfolio } from "./profile";

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
    const title = portfolio.sections.find((s) => s.id === id)?.title ?? id;
    section.innerHTML = `<div class="placeholder">${title}</div>`;
    main.append(section);
  }
  app.append(main);
}

const app = document.querySelector<HTMLElement>("#app");
if (app) {
  document.title = facts.displayName ?? "Portfolio";
  applyDesignTokens();
  renderShell(app);
}
