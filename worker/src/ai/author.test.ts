import { describe, expect, it } from "vitest";

import facts from "../../../profile/facts.json";
import personality from "../../../profile/personality.json";
import { AUTHOR_CONTEXT } from "./author";

/* Asserted against whatever profile is installed rather than against one
   person's approved words: a deployment fetches its own profile before it
   deploys, and CI runs on the tracked fixture. What has to hold either way is
   that the prompt carries the voice material and says it is only voice. */
describe("AUTHOR_CONTEXT", () => {
  it("carries the voice material the profile already approved", () => {
    expect(AUTHOR_CONTEXT).toContain(`How she writes: ${personality.communicationStyle[0].name}`);
    expect(AUTHOR_CONTEXT).toContain(`What she cares about: ${personality.values[0].name}`);
    expect(AUTHOR_CONTEXT).toContain(`Name: ${facts.displayName}`);
    expect(AUTHOR_CONTEXT).toContain(`Role: ${facts.headline}`);
  });

  it("states outright that it is not a source of facts", () => {
    // A note about coffee plus a list of interests invites the model to
    // mention clinical trials. This sentence is the only thing standing
    // between profile context and invented detail.
    expect(AUTHOR_CONTEXT).toContain("not a source of facts");
    expect(AUTHOR_CONTEXT).toContain("did not happen");
  });

  it("stays short enough not to bury the rules that follow it", () => {
    // The generation rules come after this block; a profile dump would push
    // them far enough down the prompt to start losing.
    expect(AUTHOR_CONTEXT.length).toBeLessThan(1200);
    expect(AUTHOR_CONTEXT.split("\n").length).toBeLessThan(16);
  });
});
