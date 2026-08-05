/**
 * The draft state machine (spec §22).
 *
 * The three flows the spec names are the only ones this table permits:
 *   text-only   draft → awaiting_approval → published
 *   media       draft → awaiting_approval → processing → published
 *   failure     processing → failed → processing (retry)
 *
 * Enforcing it here rather than at each call site is what stops a late callback
 * or a double-clicked button from moving a published draft back into
 * processing, or from publishing something that was cancelled.
 */
import type { Draft, DraftState } from "./types";

const TRANSITIONS: Record<DraftState, readonly DraftState[]> = {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["processing", "published", "cancelled"],
  processing: ["published", "failed", "cancelled"],
  failed: ["processing", "cancelled"],
  // Terminal. A published record is immutable, and a cancelled draft is left
  // for the lifecycle rule to remove.
  published: [],
  cancelled: [],
};

/**
 * Note that a state is never allowed to transition to itself: an edit or a
 * regeneration that leaves the draft in `awaiting_approval` is a save, not a
 * transition, and goes through saveDraft instead.
 */
export function canTransition(from: DraftState, to: DraftState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: DraftState): boolean {
  return TRANSITIONS[state].length === 0;
}

/**
 * Returns the draft moved to `next`, leaving the original untouched so a
 * rejected write cannot leave a half-updated object in memory.
 *
 * Throws on an illegal move. The caller decides what that means — a stale
 * button press is worth answering politely, a bad callback is worth a 4xx —
 * but neither should be able to write the transition.
 */
export function transition(draft: Draft, next: DraftState, now: Date = new Date()): Draft {
  if (!canTransition(draft.state, next)) {
    // Names a state pair, never draft contents: this message can reach a log.
    throw new Error(`illegal draft transition: ${draft.state} -> ${next}`);
  }

  return { ...draft, state: next, updatedAt: now.toISOString() };
}
