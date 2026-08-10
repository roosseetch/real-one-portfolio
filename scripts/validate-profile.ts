/**
 * Validates the four profile files against their JSON Schemas and rejects
 * deployment-specific values (domains, URLs, account/chat IDs, bucket hosts).
 *
 * Usage: tsx scripts/validate-profile.ts [profileDir]   (default: profile/)
 * Exit code 0 = all valid, 1 = any failure.
 *
 * The checks are exported as a function rather than run on import, so the test
 * suite can assert on the problems themselves instead of scraping stdout. The
 * command-line behaviour below is the contract CI depends on and is unchanged.
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PROFILE_FILES = ["facts", "personality", "design", "portfolio"] as const;
export type ProfileFile = (typeof PROFILE_FILES)[number];

/** Schemas describe the shape rather than the person, so they stay in the repo. */
export const SCHEMA_DIR = join(repoRoot, "profile", "schemas");

export interface ProfileProblem {
  /** Which of the four files the problem was found in. */
  file: ProfileFile;
  message: string;
}

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

function scanValues(node: unknown, path: string, report: (message: string) => void): void {
  if (typeof node === "string") {
    for (const [pattern, label] of FORBIDDEN_PATTERNS) {
      if (pattern.test(node)) report(`${path}: contains ${label}: ${JSON.stringify(node)}`);
    }
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => scanValues(item, `${path}[${i}]`, report));
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ""))) {
        report(`${path}.${key}: forbidden deployment/secret key`);
      }
      scanValues(value, `${path}.${key}`, report);
    }
  }
}

/**
 * Checks every profile file in `profileDir` and returns what is wrong with
 * them. An empty array means the profile is publishable.
 */
export function validateProfile(profileDir: string, schemaDir: string = SCHEMA_DIR): ProfileProblem[] {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const problems: ProfileProblem[] = [];

  for (const name of PROFILE_FILES) {
    const report = (message: string) => problems.push({ file: name, message });

    let data: unknown;
    const dataPath = join(profileDir, `${name}.json`);
    try {
      data = JSON.parse(readFileSync(dataPath, "utf8"));
    } catch (err) {
      report(`cannot read/parse ${dataPath}: ${(err as Error).message}`);
      continue;
    }

    const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, `${name}.schema.json`), "utf8")));
    if (!validate(data)) {
      for (const e of validate.errors ?? []) report(`schema: ${e.instancePath || "/"} ${e.message}`);
    }
    scanValues(data, name, report);
  }

  return problems;
}

/** Prints the per-file report the command line has always printed. */
function main(profileDir: string): number {
  const problems = validateProfile(profileDir);

  for (const name of PROFILE_FILES) {
    console.log(`${name}.json`);
    const own = problems.filter((problem) => problem.file === name);
    for (const problem of own) console.error(`  ✗ ${problem.message}`);
    if (own.length === 0) console.log("  ✓ valid");
  }

  if (problems.length > 0) {
    console.error(`\nProfile validation FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    return 1;
  }
  console.log("\nProfile validation passed");
  return 0;
}

// Only when run as a command. Importing the module — which the tests do — must
// not validate anything or exit the process.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv[2] ?? join(repoRoot, "profile")));
}
