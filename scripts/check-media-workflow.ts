/**
 * Holds process-media.yml to the two orderings the publication flow depends on.
 *
 * Both are invisible in review and silent when broken, which is why they are
 * checked here rather than trusted:
 *
 *   Nothing public is written before the output has been checked. The upload
 *   step is the only one that writes to a public bucket, and spec §23 requires
 *   that a run producing bad media leaves the site exactly as it was. That
 *   holds only because the verification steps run first, and moving one step
 *   past another in a YAML file is a one-line diff that reads like a tidy-up.
 *
 *   Every `steps.X.outcome` the failure report reads names a step that exists.
 *   GitHub resolves an unknown step reference to an empty string rather than
 *   failing, exactly as it does for `secrets.X` — see check-workflow-config.ts,
 *   which exists because that cost this repository a production incident. A
 *   renamed id here would not break the run; it would quietly report every
 *   failure to the author as "the processing job did not finish", losing the
 *   one sentence that says what actually went wrong.
 *
 * Exit code 0 = clean, 1 = anything wrong.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(repoRoot, ".github", "workflows", "process-media.yml");

/** The one step that writes to a public bucket, and everything that must precede it. */
const UPLOAD_STEP = "upload";
const CHECKS_BEFORE_UPLOAD = ["verify", "verify_set"];

/** Where the Worker is told a run did not finish. */
const FAILURE_ROUTE = "/callbacks/media-failed";
const FAILURE_GUARD = "if: ${{ failure() || cancelled() }}";

const workflow = readFileSync(workflowPath, "utf8");
const problems: string[] = [];

/** Step ids in the order they appear, which is the order Actions runs them in. */
const ids = [...workflow.matchAll(/^\s+id:\s*(\S+)\s*$/gm)].map((match) => match[1]);
const position = new Map(ids.map((id, index) => [id, index]));

function require(id: string): boolean {
  if (position.has(id)) return true;
  problems.push(`no step carries the id "${id}"`);
  return false;
}

if (require(UPLOAD_STEP)) {
  for (const check of CHECKS_BEFORE_UPLOAD) {
    if (!require(check)) continue;
    if (position.get(check)! > position.get(UPLOAD_STEP)!) {
      problems.push(
        `"${check}" runs after "${UPLOAD_STEP}", so unchecked media would reach the public bucket`,
      );
    }
  }
}

for (const [, id] of workflow.matchAll(/steps\.([A-Za-z0-9_-]+)\.outcome/g)) {
  if (!position.has(id)) {
    problems.push(`the failure report reads steps.${id}.outcome, but no step has that id`);
  }
}

if (!workflow.includes(FAILURE_ROUTE)) {
  problems.push(`nothing posts to ${FAILURE_ROUTE}, so a failed run would strand its draft`);
} else if (!workflow.includes(FAILURE_GUARD)) {
  // `always()` would have a successful run contradict its own callback, and
  // plain `failure()` is false for a cancelled job — which strands a draft just
  // as thoroughly as a failed one.
  problems.push(`the failure report is not guarded by \`${FAILURE_GUARD}\``);
}

if (problems.length > 0) {
  console.error("process-media.yml check failed:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Checked ${ids.length} identified steps in process-media.yml\n`);
console.log("Media workflow check passed");
