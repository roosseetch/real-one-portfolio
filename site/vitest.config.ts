import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts on purpose. That config's plugin reads
 * ../profile/*.json to write the page title, which a test run has no business
 * needing; vitest prefers this file when both exist.
 */
export default defineConfig({
  test: {
    // The Activity loader builds DOM nodes and reads document, so it needs a
    // document to build them in.
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    // The loader reads its content bucket from the build environment, exactly
    // as the deployed bundle does. Nothing is fetched from it: every response
    // in the suite is stubbed.
    env: {
      VITE_CONTENT_BASE_URL: "https://content.test",
    },
  },
});
