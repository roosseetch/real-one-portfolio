/**
 * Puts a profile in profile/ so the suites can run without a deployment.
 *
 * profile/*.json is one person's name and history, so it is not tracked: it
 * lives in the public content bucket and scripts/fetch-profile.ts downloads it
 * at build time (spec §1). But the Worker imports it to build the author
 * context, and the site imports it to render every section, so a fresh
 * checkout cannot typecheck or test until something is there.
 *
 * Rather than give the test job the deployment's variables, this copies the
 * tracked valid fixture — the same one the profile validator is tested
 * against. That keeps the PR gate hermetic: no network, no credentials, and
 * nothing that can break because someone edited their About text.
 *
 * Never overwrites. A developer with the real profile fetched keeps it, and
 * the deploy workflows still test against what production will actually use.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROFILE_FILES } from "./validate-profile.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "profile");
const fixture = join(repoRoot, "scripts", "fixtures", "valid");

mkdirSync(target, { recursive: true });

const installed: string[] = [];
for (const name of PROFILE_FILES) {
  const file = `${name}.json`;
  if (existsSync(join(target, file))) continue;
  copyFileSync(join(fixture, file), join(target, file));
  installed.push(file);
}

if (installed.length > 0) {
  console.log(`Installed the fixture profile (${installed.join(", ")}). Run npm run profile:fetch for the real one.`);
}
