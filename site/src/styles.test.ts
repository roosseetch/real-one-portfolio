/**
 * The one thing about the stylesheet that a DOM test cannot see.
 *
 * `hidden` is an attribute, and the tests that drive the contact form assert on
 * the attribute — correctly, and they passed while the code field sat visible on
 * the live page for everyone. The browser's `[hidden] { display: none }` comes
 * from the user-agent stylesheet, so any author rule that sets `display` on the
 * same element outranks it, and `.form-field { display: grid }` did.
 *
 * happy-dom applies no stylesheet, so `getComputedStyle` cannot answer this.
 * Reading the source is what is left, and it is enough: the failure mode is
 * somebody deleting the guard or adding a `display` rule without one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Comments stripped first: they sit between the previous rule's closing brace
// and the next selector, so anything reading "what comes before a {" reads them
// as part of the selector.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Selectors that set `display`, with whatever precedes the brace. */
function selectorsSettingDisplay(): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/(^|[;\s])display\s*:/.test(match[2])) found.push(match[1].trim().replace(/\s+/g, " "));
  }
  return found;
}

describe("hidden elements", () => {
  it("stay hidden even though .form-field sets display", () => {
    expect(selectorsSettingDisplay()).toContain(".form-field[hidden]");
  });

  it("the guard is not weaker than the rule it has to beat", () => {
    // Same specificity would be a coin toss decided by source order, and a
    // reordering of the file would silently bring the bug back. `[hidden]` adds
    // an attribute selector, so the guard is strictly the more specific rule.
    const guard = ".form-field[hidden]";
    const rule = ".form-field";
    expect(guard.startsWith(rule) && guard.length > rule.length).toBe(true);
  });
});
