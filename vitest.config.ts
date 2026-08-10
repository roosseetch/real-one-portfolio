import { defineConfig } from "vitest/config";

/**
 * The repository-level suite. Everything under scripts/ that has tests is
 * collected here; worker/ and site/ run their own, and `npm test` at the root
 * runs all three.
 */
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});
