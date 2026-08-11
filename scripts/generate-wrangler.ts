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
  CONTACT_WORKFLOW_FILE: "validate-contact.yml",
};

/**
 * Placeholders that may legitimately be empty.
 *
 * Every other one names something the Worker cannot run without, and an empty
 * value there means a deployment wired to nothing — which is why this script
 * refuses rather than guesses. These two configure a feature that turns itself
 * off when it is unset: no analytics key, no relay; no From: address, no
 * verification mail, and the endpoint says so instead of pretending.
 */
const OPTIONAL = new Set(["AMPLITUDE_API_KEY", "CONTACT_EMAIL_FROM"]);

const template = readFileSync(templatePath, "utf8");
const placeholders = [...new Set([...template.matchAll(/__([A-Z0-9_]+)__/g)].map((m) => m[1]))];

const missing: string[] = [];
const values = new Map<string, string>();

for (const name of placeholders) {
  const value = process.env[name] ?? DEFAULTS[name];
  if (!value) {
    if (OPTIONAL.has(name)) {
      values.set(name, "");
      continue;
    }
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

/**
 * Drops "//"-prefixed keys. JSON has no comments, but the template needs to
 * explain choices that would otherwise look arbitrary — and Wrangler warns
 * about any top-level field it does not recognise, so they cannot survive
 * into the generated file.
 */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("//"))
      .map(([key, entry]) => [key, stripComments(entry)]),
  );
}

const config = stripComments(JSON.parse(rendered)) as Record<string, unknown> & {
  name: string;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
};
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Wrote worker/wrangler.generated.json for Worker "${config.name}"`);
for (const bucket of config.r2_buckets ?? []) {
  console.log(`  ${bucket.binding} -> ${bucket.bucket_name}`);
}
