/**
 * Profile validation (spec §26).
 *
 * The two fixture profiles under scripts/fixtures are the reference cases: a
 * publishable profile, and one carrying every kind of value the repository is
 * not allowed to hold. Anything the fixtures do not cover gets a profile of its
 * own, built by mutating a valid one, so a failure names the single field that
 * caused it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { validateProfile, type ProfileFile } from "./validate-profile.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const VALID = join(repoRoot, "scripts", "fixtures", "valid");
const INVALID = join(repoRoot, "scripts", "fixtures", "invalid");

const temporary: string[] = [];

/** A copy of the valid fixture with one file replaced, for a single-cause profile. */
function profileWith(file: ProfileFile, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "profile-validation-"));
  temporary.push(dir);
  cpSync(VALID, dir, { recursive: true });
  writeFileSync(join(dir, `${file}.json`), JSON.stringify(contents));
  return dir;
}

/** The valid fixture's own facts, as a base to introduce one problem into. */
function validFacts(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(VALID, "facts.json"), "utf8")) as Record<string, unknown>;
}

const messages = (dir: string) => validateProfile(dir).map((problem) => problem.message);

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe("a publishable profile", () => {
  it("reports nothing at all", () => {
    expect(validateProfile(VALID)).toEqual([]);
  });

  it("passes the repository's own schemas, not a copy inside the fixture", () => {
    // The schemas stay tracked while profile/*.json does not, so this is the
    // pairing every deployment actually validates against.
    expect(validateProfile(VALID, join(repoRoot, "profile", "schemas"))).toEqual([]);
  });
});

describe("schema violations", () => {
  it("rejects a field that does not match its pattern", () => {
    expect(messages(INVALID)).toContainEqual(
      expect.stringContaining('/experience/0/start must match pattern'),
    );
  });

  it("rejects a property the schema does not allow", () => {
    expect(messages(INVALID)).toContainEqual(expect.stringContaining("must NOT have additional properties"));
  });

  it("names the file the problem is in", () => {
    const design = validateProfile(INVALID).filter((problem) => problem.file === "design");
    expect(design.length).toBeGreaterThan(0);
  });

  it("reports a missing file rather than passing it over", () => {
    const problems = validateProfile(join(repoRoot, "scripts", "fixtures", "nothing-here"));
    expect(problems).toHaveLength(4);
    expect(problems.map((problem) => problem.file)).toEqual(["facts", "personality", "design", "portfolio"]);
    expect(problems[0].message).toContain("cannot read/parse");
  });

  it("reports a file that is not JSON at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-validation-"));
    temporary.push(dir);
    cpSync(VALID, dir, { recursive: true });
    writeFileSync(join(dir, "facts.json"), "{ not json");
    expect(messages(dir)).toContainEqual(expect.stringContaining("cannot read/parse"));
  });
});

/* Deployment-specific values. A profile that names a domain, a bucket or an
   account is a profile that cannot be reused by the next person, which is the
   one property the whole repository is arranged around (spec §1). */
describe("values that belong in gitignored config", () => {
  it("rejects an absolute URL", () => {
    expect(messages(INVALID)).toContainEqual(expect.stringContaining("contains absolute URL"));
  });

  it("rejects a domain name", () => {
    expect(messages(INVALID)).toContainEqual(expect.stringContaining("contains domain name"));
  });

  it("rejects an e-mail address", () => {
    expect(messages(INVALID)).toContainEqual(expect.stringContaining("contains e-mail address"));
  });

  it("rejects a chat or account id", () => {
    expect(messages(INVALID)).toContainEqual(
      expect.stringContaining("contains long numeric identifier"),
    );
  });

  it("rejects a Cloudflare account or zone id", () => {
    const facts = validFacts();
    facts.location = "0123456789abcdef0123456789abcdef";
    expect(messages(profileWith("facts", facts))).toEqual([
      expect.stringContaining("contains 32-hex identifier"),
    ]);
  });

  it("rejects an R2 bucket host", () => {
    const facts = validFacts();
    facts.location = "someaccount r2.cloudflarestorage somewhere";
    expect(messages(profileWith("facts", facts))).toContainEqual(
      expect.stringContaining("contains R2 bucket host"),
    );
  });

  it("rejects a workers.dev host", () => {
    const facts = validFacts();
    facts.location = "portfolio-worker workers.dev";
    expect(messages(profileWith("facts", facts))).toContainEqual(
      expect.stringContaining("contains workers.dev host"),
    );
  });

  it("rejects a key that names infrastructure or a credential", () => {
    expect(messages(INVALID)).toContainEqual(
      expect.stringContaining("forbidden deployment/secret key"),
    );
  });

  it("catches the same key however it is spelled", () => {
    const facts = validFacts();
    facts["Account-Id"] = "an account";
    expect(messages(profileWith("facts", facts))).toContainEqual(
      expect.stringContaining("facts.Account-Id: forbidden deployment/secret key"),
    );
  });

  it("looks inside arrays and nested objects, not only at the top level", () => {
    const facts = validFacts();
    facts.skills = ["Process optimization", "Reachable at someone@example-mail.net"];
    expect(messages(profileWith("facts", facts))).toContainEqual(
      expect.stringContaining("facts.skills[1]"),
    );
  });
});

/* The exit code is the whole contract for CI: a validator that prints its
   complaints and exits 0 gates nothing. */
describe("the command line", () => {
  const run = (dir: string) =>
    spawnSync(join(repoRoot, "node_modules", ".bin", "tsx"), [join(repoRoot, "scripts", "validate-profile.ts"), dir], {
      encoding: "utf8",
    });

  it("exits 0 and says so for a valid profile", () => {
    const result = run(VALID);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Profile validation passed");
  });

  it("exits 1 and counts the problems for an invalid one", () => {
    const result = run(INVALID);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Profile validation FAILED");
    expect(result.stdout).toContain("facts.json");
  });
});
