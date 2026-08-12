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

/**
 * Every profile elsewhere this deployment claims. All optional, none guaranteed.
 *
 * Handles, never addresses. The host each one belongs to is a constant in the
 * code that renders it, because a profile naming hosts is a profile carrying
 * deployment values — which validate-profile.ts refuses outright.
 */
export interface ProfileLinks {
  linkedin?: string;
}

/**
 * The `links` block, read through a type rather than off the import.
 *
 * Every other field here is required by the schema, so its type comes free from
 * the JSON Vite inlines. This one is optional, and the inferred type is the
 * shape of whichever profile happened to be in profile/ when tsc ran — the
 * fixture in CI, a real one locally. Reading it off the import directly would
 * make the site compile only against a profile that has it, which is the
 * opposite of optional.
 */
export function profileLinks(): ProfileLinks {
  return (facts as { links?: ProfileLinks }).links ?? {};
}
