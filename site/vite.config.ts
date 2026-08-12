import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import { escape, headTags } from "./src/head";
import { ROUTES, type Route } from "./src/routes";

const readProfile = (name: string) =>
  JSON.parse(readFileSync(new URL(`../profile/${name}.json`, import.meta.url), "utf8"));

/** Absolute path of a route's HTML entry, which is also its Rollup input. */
const entryPath = (route: Route) => fileURLToPath(new URL(route.entry, import.meta.url));

/**
 * Writes the title, the social metadata and the site icon into each page's HTML
 * at build time.
 *
 * Setting document.title from JavaScript leaves the wrong name in the served
 * HTML, which is what search engines and link previews read. Injecting here
 * keeps the tracked HTML free of personal values while the built pages carry
 * the real ones.
 *
 * The icon is here for that second reason rather than the first. A logo is one
 * person's brand mark, so it belongs in the media bucket beside the portrait and
 * not in a repository meant to be reused for someone else (spec §1) — which is
 * why the tag is built from `VITE_MEDIA_BASE_URL` instead of pointing at a file
 * in `public/`. Injecting it also means a page added to routes.ts is a page with
 * an icon, rather than one more `<link>` somebody has to remember to paste.
 *
 * Every page gets its own title and description, from routes.ts: a second page
 * inheriting the landing page's is a second page indistinguishable from the
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

      const tags = headTags({ pageTitle, description, mediaBase });

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
