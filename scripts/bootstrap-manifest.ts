/**
 * Writes the empty manifest that the public content bucket needs before
 * anything can be published.
 *
 * Publication deliberately refuses to create this itself: a Worker pointed at
 * the wrong bucket would otherwise start a second, empty history rather than
 * failing where someone would notice. Bootstrapping is a decision, so it is a
 * separate, explicit step.
 *
 * Safe to run twice — an existing manifest is reported and left alone.
 *
 * Usage:
 *   set -a; . ./infrastructure/.env; . ./worker/.env; set +a
 *   npm --prefix worker run bootstrap:manifest
 *
 * Exit code 0 = manifest present (written now or already there), 1 = failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MANIFEST_KEY = "content/manifest.json";
const SCHEMA_VERSION = 1;
const RECORDS_PER_FILE = 10;

/** Spec §9.6: the manifest changes on every publication, so it is never served unchecked. */
const CACHE_CONTROL = "no-cache";

const bucket = process.env.CONTENT_BUCKET;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

const missing = Object.entries({ CONTENT_BUCKET: bucket, CLOUDFLARE_API_TOKEN: apiToken })
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error("Cannot bootstrap the manifest. Missing values:");
  for (const name of missing) console.error(`  ${name}`);
  console.error("\nCONTENT_BUCKET lives in worker/.env, CLOUDFLARE_API_TOKEN in");
  console.error("infrastructure/.env. Source both, then run again.");
  process.exit(1);
}

/** Wrangler talks to R2 for us, so this script never has to sign an S3 request itself. */
function wrangler(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("npx", ["wrangler", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    return { ok: true, output };
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${shell.stdout ?? ""}${shell.stderr ?? ""}` };
  }
}

const objectPath = `${bucket}/${MANIFEST_KEY}`;

const existing = wrangler(["r2", "object", "get", objectPath, "--remote", "--pipe"]);
if (existing.ok) {
  console.log(`A manifest already exists at ${objectPath}. Left untouched.`);
  process.exit(0);
}

// Anything other than a plain absence is a real problem — a wrong bucket name,
// a token without R2 access — and must not be papered over by writing a fresh
// manifest on top of a history that may still be there.
if (!/not found|does not exist|10007|404/i.test(existing.output)) {
  console.error(`Could not check ${objectPath}:`);
  console.error(existing.output.trim().split("\n").slice(-4).join("\n"));
  process.exit(1);
}

const manifest = {
  schemaVersion: SCHEMA_VERSION,
  updatedAt: new Date().toISOString(),
  recordsPerFile: RECORDS_PER_FILE,
  totalRecords: 0,
  records: [],
  latest: null,
};

const file = join(mkdtempSync(join(tmpdir(), "manifest-")), "manifest.json");
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

const written = wrangler([
  "r2",
  "object",
  "put",
  objectPath,
  `--file=${file}`,
  "--content-type=application/json",
  `--cache-control=${CACHE_CONTROL}`,
  "--remote",
]);

if (!written.ok) {
  console.error(`Could not write ${objectPath}:`);
  console.error(written.output.trim().split("\n").slice(-4).join("\n"));
  process.exit(1);
}

console.log(`Wrote an empty manifest to ${objectPath}`);
console.log(`  schemaVersion ${SCHEMA_VERSION}, recordsPerFile ${RECORDS_PER_FILE}, totalRecords 0`);
