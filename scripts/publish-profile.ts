/**
 * Publishes the approved profile to the public content bucket.
 *
 * The profile is deployment-specific by definition — it is one person's name,
 * role and history — so it does not belong in a repository meant to be reused
 * for someone else (spec §1). The source of truth lives in the gitignored
 * private-inputs/profile/, and this puts the publishable subset where the site
 * and the Worker can fetch it at build time.
 *
 * Authoring-only fields are dropped on the way out. `provisionalInterpretations`
 * in particular is characterisation nobody confirmed, and the whole point of
 * separating verified from provisional is that only one of them is fit to
 * publish. Nothing reads them at build time, so nothing misses them.
 *
 * Usage:
 *   set -a; . ./infrastructure/.env; . ./worker/.env; set +a
 *   npx tsx scripts/publish-profile.ts
 *
 * Exit code 0 = published, 1 = failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "private-inputs", "profile");

const FILES = ["facts", "personality", "design", "portfolio"] as const;

/**
 * Kept out of the published copy. These exist so the profile can be regenerated
 * and reviewed later; none of them is approved for publication and none is read
 * by the site or the Worker.
 */
const AUTHORING_ONLY = new Set(["provisionalInterpretations", "aboutGuidance", "verifiedObservations"]);

/**
 * Short, because the profile changes when a person's story does and a stale copy
 * would keep rendering the old one. Long enough that a page load does not refetch.
 */
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

const bucket = process.env.CONTENT_BUCKET;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

const missing = Object.entries({ CONTENT_BUCKET: bucket, CLOUDFLARE_API_TOKEN: apiToken })
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error("Cannot publish the profile. Missing values:");
  for (const name of missing) console.error(`  ${name}`);
  console.error("\nCONTENT_BUCKET lives in worker/.env, CLOUDFLARE_API_TOKEN in");
  console.error("infrastructure/.env. Source both, then run again.");
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), "profile-"));
let failed = false;

for (const name of FILES) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(join(sourceDir, `${name}.json`), "utf8"));
  } catch (error) {
    console.error(`  ✗ ${name}.json — ${(error as Error).message}`);
    failed = true;
    continue;
  }

  const dropped = Object.keys(parsed).filter((key) => AUTHORING_ONLY.has(key));
  const published = Object.fromEntries(Object.entries(parsed).filter(([key]) => !AUTHORING_ONLY.has(key)));

  const file = join(staging, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(published, null, 2)}\n`);

  try {
    execFileSync(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "put",
        `${bucket}/profile/${name}.json`,
        `--file=${file}`,
        "--content-type=application/json",
        `--cache-control=${CACHE_CONTROL}`,
        "--remote",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string };
    console.error(`  ✗ ${name}.json — upload failed`);
    console.error(`${shell.stdout ?? ""}${shell.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n"));
    failed = true;
    continue;
  }

  const note = dropped.length > 0 ? ` (kept back: ${dropped.join(", ")})` : "";
  console.log(`  ✓ profile/${name}.json${note}`);
}

if (failed) {
  console.error("\nSome files were not published.");
  process.exit(1);
}

console.log(`\nPublished to ${bucket}/profile/. Builds fetch them from the public content domain.`);
// Worth saying every time: the profile no longer lives in git, so changing it
// no longer pushes a commit, and nothing rebuilds on its own.
console.log("The site still shows the previous profile until it is rebuilt:");
console.log("  gh workflow run deploy-pages.yml --ref main");
