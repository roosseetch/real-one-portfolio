import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const readProfile = (name: string) =>
  JSON.parse(readFileSync(new URL(`../profile/${name}.json`, import.meta.url), "utf8"));

/**
 * Writes the title and social metadata into index.html at build time.
 *
 * Setting document.title from JavaScript leaves the wrong name in the served
 * HTML, which is what search engines and link previews read. Injecting here
 * keeps the tracked index.html free of personal values while the built page
 * carries the real ones.
 */
function profileMetadata(): Plugin {
  return {
    name: "profile-metadata",
    transformIndexHtml(html) {
      const facts = readProfile("facts");
      const personality = readProfile("personality");

      const name: string = facts.displayName ?? "Portfolio";
      const headline: string = facts.headline ?? "";
      const title = headline ? `${name} — ${headline}` : name;
      const intro: string = (personality.aboutText ?? "").split("\n\n")[0];
      const description = intro.length > 160 ? `${intro.slice(0, 157).trimEnd()}…` : intro;
      const mediaBase = process.env.VITE_MEDIA_BASE_URL?.replace(/\/$/, "");

      const tags = [
        `<meta name="description" content="${escape(description)}">`,
        `<meta property="og:type" content="profile">`,
        `<meta property="og:title" content="${escape(title)}">`,
        `<meta property="og:description" content="${escape(description)}">`,
        mediaBase ? `<meta property="og:image" content="${mediaBase}/media/profile/hero-800.webp">` : "",
        `<meta name="twitter:card" content="summary_large_image">`,
      ].filter(Boolean);

      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${escape(title)}</title>`)
        .replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
    },
  };
}

// Deployment-specific values arrive via environment at build time:
//   VITE_BASE             base path for GitHub Pages (default "/")
//   VITE_CONTENT_BASE_URL public content bucket base URL (Activity loader)
//   VITE_MEDIA_BASE_URL   public media bucket base URL (photos, og:image)
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [profileMetadata()],
  server: {
    fs: { allow: [".."] }
  }
});
