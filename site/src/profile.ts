// Profile files are the single source of truth for site content.
// Vite inlines these JSON imports at build time; nothing is fetched at runtime.
import facts from "../../profile/facts.json";
import personality from "../../profile/personality.json";
import design from "../../profile/design.json";
import portfolio from "../../profile/portfolio.json";

export { facts, personality, design, portfolio };

export type SectionId = (typeof portfolio.landingPageOrder)[number];

export function mediaRef(id: string) {
  return facts.mediaReferences.find((m) => m.id === id) ?? null;
}
