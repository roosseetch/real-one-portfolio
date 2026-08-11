import "./styles.css";
import { initializeAnalytics } from "./analytics";
import { facts, portfolio } from "./profile";
import { renderHero, renderAbout, renderExperience, renderHobbies, renderFooter } from "./sections";
import { renderActivity } from "./activity";
import { applyDesignTokens, renderNav } from "./shell";

const SECTION_RENDERERS: Record<string, (section: HTMLElement) => void> = {
  hero: renderHero,
  about: renderAbout,
  experience: renderExperience,
  hobbies: renderHobbies,
  activity: (section) =>
    renderActivity(section, portfolio.sections.find((s) => s.id === "activity")?.title ?? "Recent Activities"),
  footer: renderFooter
};

function renderShell(app: HTMLElement) {
  app.append(renderNav("home"));
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
