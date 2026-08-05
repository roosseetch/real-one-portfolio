import { describe, expect, it } from "vitest";

import { canTransition, isTerminal, transition } from "./state";
import { DRAFT_SCHEMA_VERSION, type Draft, type DraftState } from "./types";

const ALL_STATES: DraftState[] = [
  "draft",
  "awaiting_approval",
  "processing",
  "published",
  "failed",
  "cancelled",
];

function draftIn(state: DraftState): Draft {
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    draftId: "abc123def456ghjk",
    state,
    createdAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:00:00.000Z",
    source: { chatId: 99, senderId: 42, messageId: 7 },
    input: { text: "a morning run by the river" },
    record: null,
    preview: null,
  };
}

/** Walks a whole flow, asserting every hop is legal. */
function walk(states: DraftState[]) {
  let draft = draftIn(states[0]);
  for (const next of states.slice(1)) draft = transition(draft, next);
  return draft;
}

describe("the flows spec §22 names", () => {
  it("publishes text-only drafts", () => {
    expect(walk(["draft", "awaiting_approval", "published"]).state).toBe("published");
  });

  it("publishes media drafts through processing", () => {
    expect(walk(["draft", "awaiting_approval", "processing", "published"]).state).toBe("published");
  });

  it("retries a failed publication", () => {
    expect(walk(["processing", "failed", "processing", "published"]).state).toBe("published");
  });

  it("allows cancelling from every non-terminal state", () => {
    for (const state of ["draft", "awaiting_approval", "processing", "failed"] as DraftState[]) {
      expect(canTransition(state, "cancelled")).toBe(true);
    }
  });
});

describe("moves the state machine refuses", () => {
  it("treats published and cancelled as terminal", () => {
    expect(isTerminal("published")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    for (const next of ALL_STATES) {
      expect(canTransition("published", next)).toBe(false);
      expect(canTransition("cancelled", next)).toBe(false);
    }
  });

  it("will not reopen a published draft", () => {
    // The case a late or replayed media callback would otherwise cause.
    expect(() => transition(draftIn("published"), "processing")).toThrow(/published -> processing/);
  });

  it("will not publish a cancelled draft", () => {
    expect(() => transition(draftIn("cancelled"), "published")).toThrow();
  });

  it("will not skip approval", () => {
    expect(canTransition("draft", "published")).toBe(false);
    expect(canTransition("draft", "processing")).toBe(false);
  });

  it("will not transition a state to itself", () => {
    // An edit or regeneration that leaves the draft awaiting approval is a
    // save, not a transition.
    for (const state of ALL_STATES) expect(canTransition(state, state)).toBe(false);
  });

  it("names only the states in the error, never the draft", () => {
    const draft = draftIn("published");
    try {
      transition(draft, "processing");
      throw new Error("expected a rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(draft.input.text);
      expect(message).not.toContain(draft.draftId);
      expect(message).not.toContain(String(draft.source.senderId));
    }
  });
});

describe("transition", () => {
  it("leaves the original draft untouched", () => {
    const before = draftIn("draft");
    const after = transition(before, "awaiting_approval");
    expect(before.state).toBe("draft");
    expect(after.state).toBe("awaiting_approval");
  });

  it("stamps updatedAt and leaves createdAt alone", () => {
    const before = draftIn("draft");
    const after = transition(before, "awaiting_approval", new Date("2026-08-05T11:30:00.000Z"));
    expect(after.updatedAt).toBe("2026-08-05T11:30:00.000Z");
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("carries the rest of the draft across unchanged", () => {
    const after = transition(draftIn("draft"), "awaiting_approval");
    expect(after.input.text).toBe("a morning run by the river");
    expect(after.source).toEqual({ chatId: 99, senderId: 42, messageId: 7 });
  });
});
