/**
 * The workflow security rules (spec §24).
 *
 * A gate is only worth what it catches, so every rule here is proved by a
 * mutation: a workflow that breaks exactly one of them, and nothing else. The
 * repository's own .github/workflows is the case that has to stay clean.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { WORKFLOW_DIR, checkWorkflowSecurity } from "./check-workflow-security.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];

/** A workflow directory holding one file, so a failure names one cause. */
function workflowDir(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-security-"));
  temporary.push(dir);
  writeFileSync(join(dir, name), body);
  return dir;
}

const problems = (name: string, body: string) => checkWorkflowSecurity(workflowDir(name, body)).problems;

/** A workflow that breaks none of the rules, to mutate one thing at a time. */
const CLEAN = `name: Example

on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: someone/an-action@1111111111111111111111111111111111111111 # v3.1.0
      - run: echo hello
`;

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe("the repository's own workflows", () => {
  it("break none of the rules", () => {
    expect(checkWorkflowSecurity().problems).toEqual([]);
  });

  it("pin every third-party action and account for every write", () => {
    const report = checkWorkflowSecurity();
    expect(report.pinned).toBeGreaterThan(0);
    expect(report.writes).toBeGreaterThan(0);
  });
});

describe("the clean workflow this suite mutates", () => {
  it("passes untouched, or every case below proves nothing", () => {
    expect(problems("example.yml", CLEAN)).toEqual([]);
  });
});

describe("third-party actions", () => {
  it("rejects one pinned to a tag", () => {
    const body = CLEAN.replace(/someone\/an-action@\w+ # v3\.1\.0/, "someone/an-action@v3");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("pinned by \"v3\"")]);
  });

  it("rejects one pinned to a branch that reads like a version", () => {
    const body = CLEAN.replace(/someone\/an-action@\w+ # v3\.1\.0/, "someone/an-action@stable");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("pinned by \"stable\"")]);
  });

  it("rejects one carrying no ref at all", () => {
    const body = CLEAN.replace(/someone\/an-action@\w+ # v3\.1\.0/, "someone/an-action");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("pinned by nothing")]);
  });

  it("rejects a commit nothing says the version of", () => {
    const body = CLEAN.replace(" # v3.1.0", "");
    expect(problems("example.yml", body)).toEqual([
      expect.stringContaining("pinned but nothing says to what"),
    ]);
  });

  it("rejects a docker action pinned by tag", () => {
    const body = CLEAN.replace(/someone\/an-action@\w+ # v3\.1\.0/, "docker://vendor/tool:1.2.3 # 1.2.3");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("image digest")]);
  });

  it("accepts a docker action pinned by digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const body = CLEAN.replace(/someone\/an-action@\w+ # v3\.1\.0/, `docker://vendor/tool@${digest} # 1.2.3`);
    expect(problems("example.yml", body)).toEqual([]);
  });

  it("leaves GitHub's own actions on their major", () => {
    // actions/checkout@v7 is in every fixture above and never reported.
    const body = CLEAN.replace(/      - uses: someone.*\n/, "");
    expect(problems("example.yml", body)).toEqual([]);
  });
});

describe("permissions", () => {
  it("rejects a workflow that declares none", () => {
    const body = CLEAN.replace("permissions:\n  contents: read\n\n", "");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("no top-level permissions")]);
  });

  it("rejects write-all", () => {
    const body = CLEAN.replace("permissions:\n  contents: read", "permissions: write-all");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("grants every scope")]);
  });

  it("rejects a write nobody wrote a reason for", () => {
    const body = CLEAN.replace("contents: read", "contents: write");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("not accounted for")]);
  });

  it("counts a write the allowlist knows about", () => {
    // build-sanitizer.yml needs contents: write to publish the release asset.
    const body = CLEAN.replace("contents: read", "contents: write");
    const report = checkWorkflowSecurity(workflowDir("build-sanitizer.yml", body));
    expect(report.problems).toEqual([]);
    expect(report.writes).toBe(1);
  });

  it("does not mistake an action input for a permission", () => {
    const body = CLEAN.replace(
      "      - run: echo hello",
      "      - uses: someone/other@2222222222222222222222222222222222222222 # v1\n        with:\n          overwrite: write",
    );
    expect(problems("example.yml", body)).toEqual([]);
  });
});

describe("secrets a pull request can reach", () => {
  const withSecret = CLEAN.replace(
    "      - run: echo hello",
    "      - run: deploy\n        env:\n          TOKEN: ${{ secrets.SOME_TOKEN }}",
  );

  it("rejects an unguarded job", () => {
    expect(problems("example.yml", withSecret)).toEqual([
      expect.stringContaining("reads secrets.SOME_TOKEN"),
    ]);
  });

  it("accepts a job that refuses to run for forks", () => {
    const guarded = withSecret.replace(
      "    runs-on: ubuntu-latest",
      "    if: github.event.pull_request.head.repo.full_name == github.repository\n    runs-on: ubuntu-latest",
    );
    expect(problems("example.yml", guarded)).toEqual([]);
  });

  it("leaves the runner's own token alone", () => {
    const builtin = withSecret.replace("secrets.SOME_TOKEN", "secrets.GITHUB_TOKEN");
    expect(problems("example.yml", builtin)).toEqual([]);
  });

  it("says nothing about a workflow a pull request cannot trigger", () => {
    const onPush = withSecret.replace("  pull_request:\n", "  push:\n    branches: [main]\n");
    expect(problems("example.yml", onPush)).toEqual([]);
  });

  it("does not let a guard on one job cover the next", () => {
    const twoJobs = `${CLEAN}
  second:
    runs-on: ubuntu-latest
    steps:
      - run: deploy
        env:
          TOKEN: \${{ secrets.SOME_TOKEN }}
`.replace(
      "    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7",
      "    if: github.event.pull_request.head.repo.full_name == github.repository\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7",
    );
    expect(problems("example.yml", twoJobs)).toEqual([expect.stringContaining('job "second"')]);
  });
});

describe("pull_request_target", () => {
  it("is refused outright", () => {
    const body = CLEAN.replace("  pull_request:", "  pull_request_target:");
    expect(problems("example.yml", body)).toEqual([expect.stringContaining("pull_request_target")]);
  });
});

describe("comments", () => {
  it("does not read a rule out of prose", () => {
    const body = CLEAN.replace(
      "jobs:",
      "# Never write `permissions: write-all` here, and never use pull_request_target.\njobs:",
    );
    expect(problems("example.yml", body)).toEqual([]);
  });
});

/* The exit code is the whole contract for CI: a check that prints its
   complaints and exits 0 gates nothing. */
describe("the command line", () => {
  const run = (dir: string) =>
    spawnSync(
      join(repoRoot, "node_modules", ".bin", "tsx"),
      [join(repoRoot, "scripts", "check-workflow-security.ts"), dir],
      { encoding: "utf8" },
    );

  it("exits 0 for the repository's own workflows", () => {
    const result = run(WORKFLOW_DIR);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Workflow security check passed");
  });

  it("exits 1 and names the problem for a workflow that breaks a rule", () => {
    const dir = workflowDir("example.yml", CLEAN.replace("contents: read", "contents: write"));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Workflow security check FAILED");
  });
});
