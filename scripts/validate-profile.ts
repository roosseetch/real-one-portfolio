/**
 * Validates the four profile files against their JSON Schemas and rejects
 * deployment-specific values (domains, URLs, account/chat IDs, bucket hosts).
 *
 * Usage: tsx scripts/validate-profile.ts [profileDir]   (default: profile/)
 * Exit code 0 = all valid, 1 = any failure.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profileDir = process.argv[2] ?? join(repoRoot, "profile");
const schemaDir = join(repoRoot, "profile", "schemas");

const FILES = ["facts", "personality", "design", "portfolio"] as const;

// Deployment-specific value detection. The repo must stay reusable: real
// domains, absolute URLs, Cloudflare account/zone IDs, Telegram chat IDs,
// bucket hosts, and e-mail addresses belong in gitignored config, never in
// profile content.
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\//i, "absolute URL"],
  [/\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|me|ch|de|eu|uk|us|info|site|xyz)\b/i, "domain name"],
  [/\br2\.cloudflarestorage\b/i, "R2 bucket host"],
  [/\bworkers\.dev\b/i, "workers.dev host"],
  [/\b[0-9a-f]{32}\b/i, "32-hex identifier (account/zone ID)"],
  [/\b\d{9,}\b/, "long numeric identifier (chat/account ID)"],
  [/\S+@\S+\.\S+/, "e-mail address"],
];

const FORBIDDEN_KEYS = new Set([
  "accountid", "zoneid", "bucket", "bucketname", "domain", "rootdomain",
  "telegramid", "chatid", "token", "secret", "apikey", "password",
]);

let failCount = 0;
const fail = (msg: string) => {
  failCount++;
  console.error(`  ✗ ${msg}`);
};

function scanValues(node: unknown, path: string): void {
  if (typeof node === "string") {
    for (const [pattern, label] of FORBIDDEN_PATTERNS) {
      if (pattern.test(node)) fail(`${path}: contains ${label}: ${JSON.stringify(node)}`);
    }
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => scanValues(item, `${path}[${i}]`));
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ""))) {
        fail(`${path}.${key}: forbidden deployment/secret key`);
      }
      scanValues(value, `${path}.${key}`);
    }
  }
}

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

for (const name of FILES) {
  const schemaPath = join(schemaDir, `${name}.schema.json`);
  const dataPath = join(profileDir, `${name}.json`);
  const before = failCount;
  console.log(`${name}.json`);

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(dataPath, "utf8"));
  } catch (err) {
    fail(`cannot read/parse ${dataPath}: ${(err as Error).message}`);
    continue;
  }

  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (!validate(data)) {
    for (const e of validate.errors ?? []) fail(`schema: ${e.instancePath || "/"} ${e.message}`);
  }
  scanValues(data, name);
  if (failCount === before) console.log("  ✓ valid");
}

if (failCount > 0) {
  console.error(`\nProfile validation FAILED (${failCount} problem${failCount === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\nProfile validation passed");
