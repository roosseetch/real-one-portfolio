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
    // Both buckets come from the build environment, exactly as the deployed
    // bundle takes them. Nothing is fetched from either: every response in the
    // suite is stubbed, and happy-dom loads no images.
    //
    // The media base has to be set for the same reason the content one does.
    // Without it every photograph renders as a placeholder <div>, so the branch
    // that builds a real <img> — its srcset, and whether it is asked for
    // eagerly or lazily — is the branch no test ever reaches. That is where the
    // bug lived that left three of four hobby photographs unfetched.
    env: {
      VITE_CONTENT_BASE_URL: "https://content.test",
      VITE_MEDIA_BASE_URL: "https://media.test",
    },
  },
});
