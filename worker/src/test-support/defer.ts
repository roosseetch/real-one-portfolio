/**
 * A stand-in for the deferred context the router hands the contact handlers.
 *
 * The real one is the tracking proxy from logging/error-log.ts, whose whole
 * point is that the request's log waits for what was deferred. A test needs the
 * same thing for a different reason: an analytics upload that is only scheduled
 * when the handler returns has not been sent yet, and asserting on it before it
 * settles asserts on nothing.
 *
 * Not a test file itself — vitest only collects *.test.ts — but it lives under
 * src/ so the existing tsconfig typechecks it, and nothing in the entry graph
 * imports it, so wrangler never bundles it.
 */

export interface FakeDeferContext {
  ctx: { waitUntil(promise: Promise<unknown>): void };
  /** Resolves once everything deferred so far has finished. */
  settled(): Promise<void>;
}

export function createDeferContext(): FakeDeferContext {
  const pending: Promise<unknown>[] = [];

  return {
    ctx: {
      waitUntil(promise) {
        pending.push(promise);
      },
    },
    async settled() {
      // Deferred work can defer more work, so drain until nothing new arrives —
      // the same reason the real tracker loops.
      while (pending.length > 0) {
        await Promise.allSettled(pending.splice(0, pending.length));
      }
    },
  };
}
