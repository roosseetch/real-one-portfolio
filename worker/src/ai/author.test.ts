import { describe, expect, it } from "vitest";

import { AUTHOR_CONTEXT } from "./author";

describe("AUTHOR_CONTEXT", () => {
  it("carries the voice material the profile already approved", () => {
    expect(AUTHOR_CONTEXT).toContain("How she writes");
    expect(AUTHOR_CONTEXT).toContain("Direct and clear");
    expect(AUTHOR_CONTEXT).toContain("What she cares about");
    expect(AUTHOR_CONTEXT).toContain("Accuracy");
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
