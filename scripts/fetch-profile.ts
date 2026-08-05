/**
 * Downloads the published profile into profile/ so a build has something to
 * read.
 *
 * The profile is no longer tracked in git — it is one person's name and history,
 * which a reusable repository has no business carrying (spec §1) — so every
 * build fetches it first. Nothing else changes: the site and the Worker still
 * import profile/*.json exactly as before, the files simply arrive by download
 * rather than by checkout.
 *
 * Reads only public URLs, so CI needs no credentials for this.
 *
 * Usage:
 *   CONTENT_BASE_URL=https://content.example npx tsx scripts/fetch-profile.ts
 *
 * Exit code 0 = profile written, 1 = anything missing or unreadable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(repoRoot, "profile");

const FILES = ["facts", "personality", "design", "portfolio"] as const;

const base = process.env.CONTENT_BASE_URL?.replace(/\/$/, "");

if (!base) {
  console.error("Cannot fetch the profile. CONTENT_BASE_URL is not set.");
  console.error("\nIt lives in worker/.env locally, and is a repository variable in CI.");
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

let failed = false;

for (const name of FILES) {
  const url = `${base}/profile/${name}.json`;

  try {
    // no-store, because a build reading a cached profile would bake yesterday's
    // wording into today's site.
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = await response.text();
    // Parsed before writing: a truncated or HTML error page written to
    // profile/facts.json would fail much later and much more confusingly.
    JSON.parse(body);

    writeFileSync(join(targetDir, `${name}.json`), body.endsWith("\n") ? body : `${body}\n`);
    console.log(`  ✓ profile/${name}.json`);
  } catch (error) {
    console.error(`  ✗ ${name}.json — ${(error as Error).message}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nThe profile is incomplete, so the build would produce a broken site.");
  console.error("Publish it first: npx tsx scripts/publish-profile.ts");
  process.exit(1);
}

console.log(`\nProfile fetched from ${base}/profile/`);
