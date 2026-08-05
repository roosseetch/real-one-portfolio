/**
 * Renders worker/wrangler.template.json into the gitignored
 * worker/wrangler.generated.json.
 *
 * Every __PLACEHOLDER__ in the template is filled from the environment
 * variable of the same name. That keeps deployment-specific names, the Worker
 * name, bucket names, and public URLs out of tracked files, and it fails loudly
 * rather than deploying a Worker wired to the wrong bucket.
 *
 * Usage: tsx scripts/generate-wrangler.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(repoRoot, "worker", "wrangler.template.json");
const outputPath = join(repoRoot, "worker", "wrangler.generated.json");

const DEFAULTS: Record<string, string> = {
  MEDIA_WORKFLOW_FILE: "process-media.yml",
};

const template = readFileSync(templatePath, "utf8");
const placeholders = [...new Set([...template.matchAll(/__([A-Z0-9_]+)__/g)].map((m) => m[1]))];

const missing: string[] = [];
const values = new Map<string, string>();

for (const name of placeholders) {
  const value = process.env[name] ?? DEFAULTS[name];
  if (!value) {
    missing.push(name);
    continue;
  }
  values.set(name, value);
}

if (missing.length > 0) {
  console.error("Cannot generate the Wrangler configuration. Missing values:");
  for (const name of missing) console.error(`  ${name}`);
  console.error("\nSet them in worker/.env or export them, then run again.");
  process.exit(1);
}

let rendered = template;
for (const [name, value] of values) {
  // JSON.stringify the value first so quotes or backslashes cannot break out
  // of the string they are substituted into.
  rendered = rendered.replaceAll(`"__${name}__"`, JSON.stringify(value));
  rendered = rendered.replaceAll(`__${name}__`, value);
}

const config = JSON.parse(rendered);
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Wrote worker/wrangler.generated.json for Worker "${config.name}"`);
for (const bucket of config.r2_buckets ?? []) {
  console.log(`  ${bucket.binding} -> ${bucket.bucket_name}`);
}
