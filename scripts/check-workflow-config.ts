/**
 * Holds .github/workflows/ and .github/config-inventory.json to each other, and
 * optionally to what the repository on GitHub actually holds.
 *
 * GitHub resolves an unknown `secrets.NAME` or `vars.NAME` to an empty string
 * rather than failing, so a renamed or mistyped reference produces a workflow
 * that runs, reports success, and does the wrong thing. That has happened twice
 * here: `secrets.GITHUB_DISPATCH_TOKEN`, a name GitHub refuses to store at all,
 * reached production and turned every photo publication into "Publication
 * failed" with no run to look at; and terraform-plan.yml still references three
 * read-only credentials that were never created.
 *
 * Two modes, because the two failures are different:
 *
 *   offline (default)  Every reference is declared in the inventory and every
 *                      declaration is referenced. Needs no credentials, so CI
 *                      runs it on every pull request, including forks. This is
 *                      the mode that catches a typo before it merges.
 *
 *   --live             Additionally asks GitHub which variables and secrets
 *                      exist and reports the required ones that do not. Needs
 *                      an authenticated gh, so it is a local check.
 *
 * Usage:
 *   npm run config:check
 *   npm run config:check -- --live [--repo owner/name]
 *
 * gh runs in a container by default, per this machine's convention. Override
 * with GH_CMD, e.g. GH_CMD=gh to use a host installation.
 *
 * Exit code 0 = clean, 1 = anything wrong.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = join(repoRoot, ".github", "workflows");
const inventoryPath = join(repoRoot, ".github", "config-inventory.json");

/** Always provided by the Actions runner, so it is never declared. */
const BUILT_IN_SECRETS = new Set(["GITHUB_TOKEN"]);

/**
 * GitHub reserves this prefix and refuses to store a secret or variable using
 * it, so such a reference can never resolve to anything. This is not a style
 * rule: `secrets.GITHUB_DISPATCH_TOKEN` shipped to production here for exactly
 * this reason, and `vars.GITHUB_PAGES_OWNER` sat in both Terraform workflows
 * unnoticed because an empty value happened to be the wanted one.
 *
 *   https://docs.github.com/en/actions/learn-github-actions/variables#naming-conventions-for-configuration-variables
 */
const RESERVED_PREFIX = /^GITHUB_/i;

const DEFAULT_GH_CMD =
  "podman run --rm -v gh-auth:/root/.config/gh docker.io/maniator/gh";

type Kind = "variables" | "secrets";

interface Entry {
  required: boolean;
  purpose: string;
  whenUnset?: string;
}

interface Inventory {
  variables: Record<string, Entry>;
  secrets: Record<string, Entry>;
}

interface Reference {
  kind: Kind;
  name: string;
  workflow: string;
  line: number;
  /** The expression the reference sits in states what an empty value means. */
  guarded: boolean;
}

const problems: string[] = [];
const notes: string[] = [];
const fail = (msg: string) => problems.push(msg);

// --- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const live = args.includes("--live");
const repoArgIndex = args.indexOf("--repo");
const repoArg = repoArgIndex === -1 ? undefined : args[repoArgIndex + 1];

for (const arg of args) {
  if (arg !== "--live" && arg !== "--repo" && arg !== repoArg) {
    fail(`unknown argument: ${arg}`);
  }
}

// --- the inventory -----------------------------------------------------------

const inventory: Inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));

for (const kind of ["variables", "secrets"] as const) {
  for (const [name, entry] of Object.entries(inventory[kind])) {
    const at = `inventory ${kind}.${name}`;
    if (RESERVED_PREFIX.test(name)) {
      fail(`${at}: GitHub reserves the GITHUB_ prefix and will not store this name. Rename it.`);
    }
    if (typeof entry.required !== "boolean") fail(`${at}: "required" must be true or false`);
    if (!entry.purpose?.trim()) fail(`${at}: needs a "purpose"`);
    // An optional entry that never says what unset means is an optional entry
    // nobody has thought about.
    if (entry.required === false && !entry.whenUnset?.trim()) {
      fail(`${at}: optional, so it needs a "whenUnset" saying what happens without it`);
    }
    if (entry.required === true && entry.whenUnset) {
      fail(`${at}: required, so "whenUnset" does not apply`);
    }
  }
}

// --- what the workflows reference --------------------------------------------

/**
 * Blanks out YAML comments so a name merely discussed in prose is not counted
 * as a reference. Blanking rather than deleting keeps every offset intact.
 */
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const at = line.search(/(^|\s)#/);
      return at === -1 ? line : line.slice(0, at) + " ".repeat(line.length - at);
    })
    .join("\n");
}

/** Spans of `${{ … }}`, so a reference can be read together with its fallback. */
function expressionSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let at = text.indexOf("${{"); at !== -1; at = text.indexOf("${{", at + 1)) {
    const end = text.indexOf("}}", at);
    if (end === -1) break;
    spans.push([at, end + 2]);
  }
  return spans;
}

const references: Reference[] = [];
const workflowFiles = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f)).sort();

for (const file of workflowFiles) {
  const text = stripComments(readFileSync(join(workflowDir, file), "utf8"));
  const spans = expressionSpans(text);

  for (const match of text.matchAll(/\b(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const kind: Kind = match[1] === "secrets" ? "secrets" : "variables";
    const name = match[2];
    if (kind === "secrets" && BUILT_IN_SECRETS.has(name)) continue;

    const at = match.index;
    // Inside `${{ … }}` the whole expression is the context; a bare reference in
    // an `if:` is bounded by its line.
    const span = spans.find(([start, end]) => at >= start && at < end);
    const context = span
      ? text.slice(span[0], span[1])
      : text.slice(text.lastIndexOf("\n", at) + 1, (text.indexOf("\n", at) + 1 || text.length) - 1);

    references.push({
      kind,
      name,
      workflow: file,
      line: text.slice(0, at).split("\n").length,
      guarded: /\|\||[!=]==?/.test(context),
    });
  }
}

if (references.length === 0) fail("no secrets.* or vars.* references found — is the scanner broken?");

// --- offline: the two must agree ---------------------------------------------

for (const ref of references) {
  const entry = inventory[ref.kind][ref.name];
  const where = `${ref.workflow}:${ref.line}`;

  if (RESERVED_PREFIX.test(ref.name)) {
    fail(
      `${where}: ${ref.name} starts with GITHUB_, which GitHub reserves. It will not store ` +
        `a secret or variable under this name, so the reference can never resolve to anything. ` +
        `Rename it and use the new name here.`,
    );
    continue;
  }

  if (!entry) {
    fail(
      `${where}: ${ref.kind === "secrets" ? "secrets" : "vars"}.${ref.name} is not declared in ` +
        `.github/config-inventory.json. GitHub would resolve it to an empty string.`,
    );
    continue;
  }

  if (!entry.required && !ref.guarded) {
    fail(
      `${where}: ${ref.name} is declared optional, so its reference must carry a ` +
        `fallback (|| …) or a comparison. As written an unset value is indistinguishable ` +
        `from a mistake.`,
    );
  }
}

for (const kind of ["variables", "secrets"] as const) {
  for (const name of Object.keys(inventory[kind])) {
    if (!references.some((r) => r.kind === kind && r.name === name)) {
      fail(`inventory ${kind}.${name}: declared but no workflow references it`);
    }
  }
}

// --- live: what GitHub actually holds ----------------------------------------

function gh(...ghArgs: string[]): string {
  const [command, ...prefix] = (process.env.GH_CMD ?? DEFAULT_GH_CMD).split(/\s+/);
  return execFileSync(command, [...prefix, ...ghArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function currentRepo(): string {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot read owner/name out of the origin remote: ${url}`);
  return match[1];
}

if (live) {
  const repo = repoArg ?? currentRepo();
  console.log(`Asking GitHub what ${repo} holds…\n`);

  const present: Record<Kind, Set<string>> = { variables: new Set(), secrets: new Set() };

  for (const { name } of JSON.parse(gh("variable", "list", "--repo", repo, "--json", "name"))) {
    present.variables.add(name);
  }
  for (const { name } of JSON.parse(gh("secret", "list", "--repo", repo, "--json", "name"))) {
    present.secrets.add(name);
  }

  // Environment-scoped values shadow repository ones, so a name defined only on
  // an environment still resolves for the jobs that use it.
  for (const env of JSON.parse(gh("api", `repos/${repo}/environments`)).environments ?? []) {
    const path = `repos/${repo}/environments/${encodeURIComponent(env.name)}`;
    for (const v of JSON.parse(gh("api", `${path}/variables`)).variables ?? []) {
      present.variables.add(v.name);
    }
    for (const s of JSON.parse(gh("api", `${path}/secrets`)).secrets ?? []) {
      present.secrets.add(s.name);
    }
  }

  for (const kind of ["variables", "secrets"] as const) {
    for (const [name, entry] of Object.entries(inventory[kind])) {
      if (present[kind].has(name)) continue;
      const label = `${kind === "secrets" ? "secret" : "variable"} ${name}`;
      if (entry.required) {
        fail(`${label} is required but does not exist on GitHub. ${entry.purpose}`);
      } else {
        notes.push(`${label} is unset. ${entry.whenUnset}`);
      }
    }

    for (const name of present[kind]) {
      if (!inventory[kind][name]) {
        notes.push(`${kind === "secrets" ? "secret" : "variable"} ${name} exists but no workflow uses it.`);
      }
    }
  }
}

// --- report ------------------------------------------------------------------

console.log(
  `Checked ${references.length} reference${references.length === 1 ? "" : "s"} across ` +
    `${workflowFiles.length} workflows against ` +
    `${Object.keys(inventory.variables).length} variables and ` +
    `${Object.keys(inventory.secrets).length} secrets.`,
);

if (notes.length > 0) {
  console.log("");
  for (const note of notes) console.log(`  · ${note}`);
}

if (problems.length > 0) {
  console.error("");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    `\nWorkflow config check FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"})`,
  );
  process.exit(1);
}

console.log("\nWorkflow config check passed");
