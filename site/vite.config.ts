import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import { ROUTES, type Route } from "./src/routes";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const readProfile = (name: string) =>
  JSON.parse(readFileSync(new URL(`../profile/${name}.json`, import.meta.url), "utf8"));

/** Absolute path of a route's HTML entry, which is also its Rollup input. */
const entryPath = (route: Route) => fileURLToPath(new URL(route.entry, import.meta.url));

/**
 * Writes the title and social metadata into each page's HTML at build time.
 *
 * Setting document.title from JavaScript leaves the wrong name in the served
 * HTML, which is what search engines and link previews read. Injecting here
 * keeps the tracked HTML free of personal values while the built pages carry
 * the real ones.
 *
 * Every page gets its own, from routes.ts: a second page inheriting the landing
 * page's title and description is a second page indistinguishable from the
 * first in a search result.
 */
function profileMetadata(): Plugin {
  return {
    name: "profile-metadata",
    transformIndexHtml(html, ctx) {
      const facts = readProfile("facts");
      const personality = readProfile("personality");

      // By filename rather than by URL path: in dev the same page is served
      // from both /contact/ and /contact/index.html.
      const route = ROUTES.find((candidate) => ctx.filename === entryPath(candidate));

      const name: string = facts.displayName ?? "Portfolio";
      const headline: string = facts.headline ?? "";
      const pageTitle = route?.title
        ? `${route.title} — ${name}`
        : headline
          ? `${name} — ${headline}`
          : name;

      const intro: string = (personality.aboutText ?? "").split("\n\n")[0];
      const summary = intro.length > 160 ? `${intro.slice(0, 157).trimEnd()}…` : intro;
      const description = route?.description ?? summary;
      const mediaBase = process.env.VITE_MEDIA_BASE_URL?.replace(/\/$/, "");

      const tags = [
        `<meta name="description" content="${escape(description)}">`,
        `<meta property="og:type" content="profile">`,
        `<meta property="og:title" content="${escape(pageTitle)}">`,
        `<meta property="og:description" content="${escape(description)}">`,
        mediaBase ? `<meta property="og:image" content="${mediaBase}/media/profile/hero-800.webp">` : "",
        `<meta name="twitter:card" content="summary_large_image">`,
      ].filter(Boolean);

      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${escape(pageTitle)}</title>`)
        .replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
    },
  };
}

// Deployment-specific values arrive via environment at build time:
//   VITE_BASE               base path for GitHub Pages (default "/")
//   VITE_CONTENT_BASE_URL   public content bucket base URL (Activity loader)
//   VITE_MEDIA_BASE_URL     public media bucket base URL (photos, og:image)
//   VITE_WORKER_BASE_URL    Worker origin the contact form posts to
//   VITE_TURNSTILE_SITE_KEY public Turnstile key for the contact form's challenge
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [profileMetadata()],
  build: {
    rollupOptions: {
      // One input per route. Rollup keeps each entry's directory, so
      // contact/index.html is emitted at contact/index.html and Pages serves
      // /contact/ with a 200 rather than through a 404 fallback.
      input: Object.fromEntries(ROUTES.map((route) => [route.id, entryPath(route)])),
    },
  },
  server: {
    fs: { allow: [".."] }
  }
});
