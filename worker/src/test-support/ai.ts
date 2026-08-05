/**
 * A scripted stand-in for the Workers AI binding.
 *
 * Each queued step is one `run` call: an object to return, or an Error to
 * throw. Once the script runs out the last step repeats, so a test that only
 * cares about the happy path can queue one response and ignore retry counts.
 */

export type AiStep = { response: unknown } | Error;

export interface FakeAi {
  AI: Ai;
  /** How many times the model was asked, for pinning down retry behaviour. */
  calls: Array<{ model: string; input: unknown }>;
}

export function createFakeAi(...steps: AiStep[]): FakeAi {
  const calls: Array<{ model: string; input: unknown }> = [];

  const AI = {
    async run(model: string, input: unknown) {
      calls.push({ model, input });

      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === undefined) throw new Error("no AI response queued");
      if (step instanceof Error) throw step;

      return step;
    },
  };

  // The binding exposes far more than run(); asserting the rest here would be
  // scaffolding nothing reads.
  return { AI: AI as unknown as Ai, calls };
}

/** A well-formed model response, with fields overridable per test. */
export function aiRecord(overrides: Record<string, unknown> = {}): AiStep {
  return {
    response: JSON.stringify({
      title: "Morning run by the river",
      summary: "An easy 8 km before work.",
      body: "Cool air, quiet paths, and a good pace.",
      eventDate: "2026-07-28",
      tags: ["Jogging"],
      ...overrides,
    }),
  };
}
