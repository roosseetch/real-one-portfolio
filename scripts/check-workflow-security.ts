/**
 * The supply-chain and permission rules for .github/workflows/ (spec §24).
 *
 * Sibling of check-workflow-config.ts, which holds the same files to the
 * variable and secret inventory. This one holds them to four rules that are
 * invisible in review and silent when broken:
 *
 *   1. Third-party actions are pinned by commit, not by tag. A tag is a name
 *      its owner can move: `@v2` today and `@v2` tomorrow can be different
 *      code, and this repository hands those actions a runner holding
 *      credentials for the private bucket and for Cloudflare.
 *   2. Every workflow declares its permissions, and every `write` is one
 *      somebody wrote down here on purpose. Without a block the token is
 *      whatever the repository setting happens to be, which is not a decision
 *      this file records.
 *   3. A workflow a pull request can trigger does not hand secrets to a branch
 *      nobody has read. Secrets are legal there only inside a job that refuses
 *      to run for forks.
 *   4. Nothing uses pull_request_target, which runs the base branch's workflow
 *      with full secrets against a fork's code.
 *
 * Deliberately text-based and dependency-free, like its sibling, so it runs in
 * the same credential-free gate on every pull request.
 *
 * Usage: npm run security:check [workflowDir]
 * Exit code 0 = clean, 1 = anything wrong.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOW_DIR = join(repoRoot, ".github", "workflows");

/**
 * Actions published by GitHub itself, from the account that also runs them.
 * Pinning these to a major is GitHub's own documented advice, and a tag moved
 * here is a tag GitHub moved.
 */
const FIRST_PARTY = /^actions\//;

/** 40 hex for a git commit; a docker action carries an image digest instead. */
const COMMIT_PIN = /^[0-9a-f]{40}$/;
const DIGEST_PIN = /^sha256:[0-9a-f]{64}$/;

/**
 * Every `write` permission in the repository, and why it has one. A new one
 * fails this check until it is added here, which is the point: the reason is
 * the part that gets lost.
 */
const ALLOWED_WRITES: Record<string, Record<string, string>> = {
  "build-sanitizer.yml": {
    contents: "creates the sanitizer-v<version> release the media pipeline downloads",
  },
  "deploy-pages.yml": {
    pages: "publishes the built site",
    "id-token": "the OIDC token actions/deploy-pages exchanges for its deployment",
  },
};

/** Same-repository branches only. Written this way in terraform-plan.yml. */
const FORK_GUARD = /head\.repo\.full_name\s*==\s*github\.repository/;

/** Blanks comments while keeping every offset, so prose cannot look like code. */
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const at = line.search(/(^|\s)#/);
      return at === -1 ? line : line.slice(0, at) + " ".repeat(line.length - at);
    })
    .join("\n");
}

interface Job {
  id: string;
  /** 1-based line of the job's key, for reporting. */
  line: number;
  body: string[];
}

/** Splits a workflow into its jobs. Job ids sit at two spaces, their keys at four. */
function jobsOf(lines: string[]): Job[] {
  const isJobKey = (line: string) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line);
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];

  const jobs: Job[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (!match) continue;
    const end = lines.findIndex((line, at) => at > i && isJobKey(line));
    jobs.push({ id: match[1], line: i + 1, body: lines.slice(i + 1, end === -1 ? lines.length : end) });
  }
  return jobs;
}

/** True when this line's `scope: write` sits inside a permissions block. */
function insidePermissions(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\s+[a-z-]+:\s*(read|write|none)\s*$/.test(line)) continue;
    return /permissions:\s*$/.test(line);
  }
  return false;
}

export interface SecurityReport {
  problems: string[];
  /** Third-party action references pinned by commit or digest. */
  pinned: number;
  /** Write permissions found, all of which had to be accounted for. */
  writes: number;
}

export function checkWorkflowSecurity(workflowDir: string = WORKFLOW_DIR): SecurityReport {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);

  const files = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort();
  if (files.length === 0) fail("no workflows found — is the scanner looking in the right place?");

  let pinned = 0;
  let writes = 0;

  for (const file of files) {
    const raw = readFileSync(join(workflowDir, file), "utf8");
    const lines = raw.split("\n");
    const code = stripComments(raw).split("\n");

    // --- 1. third-party actions are pinned by commit -------------------------

    for (const [index, line] of lines.entries()) {
      const match = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
      if (!match) continue;

      const ref = match[1];
      const where = `${file}:${index + 1}`;
      const comment = line.slice(match[0].length).trim();

      // A local composite action is this repository's own code.
      if (ref.startsWith("./") || FIRST_PARTY.test(ref)) continue;

      const at = ref.lastIndexOf("@");
      const version = at === -1 ? "" : ref.slice(at + 1);
      const docker = ref.startsWith("docker://");

      if (!(docker ? DIGEST_PIN : COMMIT_PIN).test(version)) {
        fail(
          `${where}: ${ref} is a third-party action pinned by ${version === "" ? "nothing" : `"${version}"`}. ` +
            `Pin it to the ${docker ? "image digest (@sha256:…)" : "full commit SHA"}: a tag or branch is a ` +
            `name its owner can move.`,
        );
        continue;
      }

      if (!/^#\s*\S/.test(comment)) {
        fail(`${where}: ${ref.slice(0, at)} is pinned but nothing says to what. Add a trailing comment naming the version.`);
        continue;
      }
      pinned++;
    }

    // --- 2. permissions are declared, and every write is deliberate ----------

    if (!code.some((line) => /^permissions:/.test(line))) {
      fail(
        `${file}: declares no top-level permissions, so the token is whatever the repository default ` +
          `happens to be. State them, even when the answer is "contents: read".`,
      );
    }

    for (const [index, line] of code.entries()) {
      if (/^\s*permissions:\s*(read-all|write-all)\s*$/.test(line)) {
        fail(`${file}:${index + 1}: ${line.trim()} grants every scope at once. List the scopes this workflow needs.`);
        continue;
      }

      const scope = line.match(/^\s+([a-z-]+):\s*write\s*$/);
      if (!scope || !insidePermissions(code, index)) continue;

      writes++;
      if (ALLOWED_WRITES[file]?.[scope[1]] === undefined) {
        fail(
          `${file}:${index + 1}: ${scope[1]}: write is not accounted for in ` +
            `scripts/check-workflow-security.ts. Add it there with the reason it is needed, or drop it.`,
        );
      }
    }

    // --- 3 & 4. what a pull request can reach --------------------------------

    if (code.some((line) => /^\s{2}pull_request_target:/.test(line))) {
      fail(
        `${file}: uses pull_request_target, which runs this repository's workflow and its secrets ` +
          `against a fork's code. Use pull_request.`,
      );
    }

    if (!code.some((line) => /^\s{2}pull_request:/.test(line))) continue;

    for (const job of jobsOf(code)) {
      const secret = job.body.join("\n").match(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/);
      // The runner's own token is scoped by the permissions block above.
      if (!secret || secret[1] === "GITHUB_TOKEN") continue;

      const condition = job.body.find((line) => /^ {4}if:/.test(line)) ?? "";
      if (!FORK_GUARD.test(condition)) {
        fail(
          `${file}:${job.line}: job "${job.id}" reads secrets.${secret[1]} and a pull request can trigger it. ` +
            `Guard the job with \`if: … github.event.pull_request.head.repo.full_name == github.repository\`, ` +
            `or move the step into a workflow a pull request cannot reach.`,
        );
      }
    }
  }

  return { problems, pinned, writes };
}

function main(workflowDir: string): number {
  const { problems, pinned, writes } = checkWorkflowSecurity(workflowDir);
  const files = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).length;

  console.log(
    `Checked ${files} workflows: ${pinned} third-party action reference${pinned === 1 ? "" : "s"} ` +
      `pinned by commit or digest, ${writes} write permission${writes === 1 ? "" : "s"} accounted for.`,
  );

  if (problems.length > 0) {
    console.error("");
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error(`\nWorkflow security check FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    return 1;
  }

  console.log("\nWorkflow security check passed");
  return 0;
}

// Only when run as a command. Importing the module — which the tests do — must
// not check anything or exit the process.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv[2] ?? WORKFLOW_DIR));
}
