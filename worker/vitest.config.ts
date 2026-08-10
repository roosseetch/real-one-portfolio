import { defineConfig } from "vitest/config";

/**
 * Explicit, and not optional: with no config here vitest walks up and finds
 * the repository root's, whose include pattern covers scripts/ only — so the
 * Worker's whole suite reports "no test files found" and the deploy that runs
 * it exits 1.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
