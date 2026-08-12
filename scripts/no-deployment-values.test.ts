/**
 * No tracked file names a real deployment (spec §1, §24).
 *
 * The repository is meant to be reused, and it is public. A domain that belongs
 * to whoever deployed it first therefore has no business in it — every URL in
 * tracked source has to be one of the names reserved for documentation, or a
 * third-party service the code genuinely calls.
 *
 * Written as a test rather than another CLI gate because it is an assertion
 * about the repository, and this suite already runs on every pull request that
 * touches the source. It caught one: worker/src/analytics/proxy.test.ts used
 * the author's own domain as the allowed origin, which read as a fixture and
 * was a deployment value.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Names reserved for examples and tests, which can never belong to anyone.
 *   RFC 2606 (.test, .example, .invalid, example.com) and RFC 6761.
 */
const RESERVED = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|net|org)$/;

/** Real hosts the code or the documentation actually addresses. */
const ALLOWED = new Set([
  "api.telegram.org",
  "t.me",
  "api.cloudflare.com",
  "challenges.cloudflare.com",
  "dash.cloudflare.com",
  "developers.cloudflare.com",
  "api2.amplitude.com",
  "api.resend.com",
  // The repost path: www for the OAuth endpoints and the feed URLs a post
  // lands at, api for /rest/posts and /v2/userinfo.
  "www.linkedin.com",
  "api.linkedin.com",
  "github.com",
  "api.github.com",
  "docs.github.com",
  // Where LinkedIn's API reference lives, cited by the version pin in post.ts.
  "learn.microsoft.com",
  "json-schema.org",
  "registry.npmjs.org",
  // Not a host this addresses at all: `http://www.w3.org/2000/svg` is the XML
  // namespace `createElementNS` requires, and the string is the identifier
  // rather than an address — nothing fetches it, and it is the same constant in
  // every document that has ever contained an inline SVG.
  "www.w3.org",
]);

/**
 * Dependency lockfiles, which are thousands of registry URLs nobody wrote and
 * npm rewrites wholesale.
 */
const SKIPPED = /(^|\/)package-lock\.json$|(^|\/)Cargo\.lock$/;

const URL_PATTERN = /https?:\/\/([A-Za-z0-9._-]+)/g;

interface Offence {
  file: string;
  line: number;
  host: string;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((file) => file !== "" && !SKIPPED.test(file));
}

function offences(): Offence[] {
  const found: Offence[] = [];

  for (const file of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      continue; // Binary, or a path this checkout does not have.
    }
    // A NUL byte means the file is binary, whatever its extension says.
    if (text.includes("\u0000")) continue;

    for (const [index, line] of text.split("\n").entries()) {
      for (const match of line.matchAll(URL_PATTERN)) {
        const host = match[1].toLowerCase().replace(/\.$/, "");
        // An interpolated host is a variable, not a value: `https://${base}/x`
        // and `https://${{ vars.X }}.example` name nothing on their own.
        if (line.slice(match.index).startsWith("https://${") || host.includes("$")) continue;
        if (RESERVED.test(host) || ALLOWED.has(host)) continue;
        found.push({ file, line: index + 1, host });
      }
    }
  }

  return found;
}

describe("tracked files", () => {
  it("name no host outside the reserved names and the services the code calls", () => {
    // The message is the finding: file, line, and the host that has to go.
    expect(offences().map((o) => `${o.file}:${o.line} ${o.host}`)).toEqual([]);
  });

  it("would notice one if it came back", () => {
    // Guards the matcher itself: a scan that quietly matches nothing would pass
    // the assertion above for ever.
    // Assembled rather than written out. This file is tracked, so the scan
    // above reads it too, and a literal here is the very thing it forbids —
    // which is how the first version of this test failed its own rule.
    const url = ["https:/", "/someones-real-site.com"].join("");
    const line = `const ORIGIN = "${url}";`;
    const hosts = [...line.matchAll(URL_PATTERN)]
      .map((match) => match[1])
      .filter((host) => !RESERVED.test(host) && !ALLOWED.has(host));
    expect(hosts).toEqual(["someones-real-site.com"]);
  });

  it("accepts the reserved names the fixtures use", () => {
    for (const host of ["site.example", "worker.example", "media.test", "example.com", "localhost"]) {
      expect(RESERVED.test(host)).toBe(true);
    }
  });
});
