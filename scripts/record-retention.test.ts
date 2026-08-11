/**
 * The contact records outlive the bucket's lifecycle rules.
 *
 * `contact-records/` and `contact/` are one character apart, and they mean
 * opposite things: everything under `contact/` is swept within days, and
 * everything under `contact-records/` is meant to be kept until somebody
 * deliberately removes it. A rule whose prefix lost its trailing slash would
 * start quietly deleting the record of every message the site has ever
 * received, and nothing would fail — the files would simply stop being there.
 *
 * Written as a test rather than a comment because the two files that have to
 * agree are a Terraform config and a Worker module, which nothing else compares.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every prefix the private bucket's lifecycle rules expire. */
function expiringPrefixes(): string[] {
  const config = readFileSync(join(repoRoot, "infrastructure/main/lifecycle.tf"), "utf8");
  return [...config.matchAll(/prefix\s*=\s*"([^"]*)"/g)].map((match) => match[1]);
}

/** Where the Worker keeps the records that must survive. */
function recordsPrefix(): string {
  const source = readFileSync(join(repoRoot, "worker/src/contact/records.ts"), "utf8");
  const match = source.match(/const PREFIX = "([^"]+)"/);
  if (match === null) throw new Error("records.ts no longer declares a PREFIX to check");
  return match[1];
}

describe("the contact records", () => {
  it("are not under any prefix the bucket expires", () => {
    const records = recordsPrefix();
    const sweeping = expiringPrefixes().filter((prefix) => records.startsWith(prefix));

    // The message names the rule that would eat them, because that is the whole
    // finding: which prefix, and what it now matches.
    expect(sweeping).toEqual([]);
  });

  it("would notice the trailing slash going missing", () => {
    // Guards the check itself. `contact` without its slash matches
    // `contact-records/`, which is exactly the mistake worth catching, and a
    // matcher that could not see it would pass the assertion above for ever.
    expect("contact-records/".startsWith("contact")).toBe(true);
    expect("contact-records/".startsWith("contact/")).toBe(false);
  });

  it("still expires the submissions themselves", () => {
    // The other half of the bargain: a message in flight is swept within days.
    // If this stops being true, a stranger's words start living in two places
    // instead of one.
    expect(expiringPrefixes()).toContain("contact/");
  });
});
