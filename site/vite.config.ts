import { defineConfig } from "vite";

// Deployment-specific values arrive via environment at build time:
//   VITE_BASE             base path for GitHub Pages (default "/")
//   VITE_CONTENT_BASE_URL public content bucket base URL (Activity loader)
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  server: {
    fs: { allow: [".."] }
  }
});
