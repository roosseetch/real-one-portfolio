/**
 * Workers AI turns what the author typed into the record proposed for
 * publication (spec §8).
 *
 * The model writes prose and nothing else. Every identifier, path, URL and
 * state transition is decided by code elsewhere, so a bad generation can only
 * ever produce bad text — never a write to the wrong object.
 */
import type { DraftRecord } from "../drafts/types";
import { RECORD_JSON_SCHEMA, parseRecord } from "./schema";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Two more tries after the first. Constrained decoding rarely needs them, and a stuck model will not improve on the fourth. */
const MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = [
  "You turn a short personal note into a structured entry for someone's personal website.",
  "",
  "Rules:",
  "- Use only what the note says. Never invent places, people, distances, times or achievements.",
  "- Keep the author's voice and first person. Do not make it sound like a press release.",
  "- The body may tidy grammar and phrasing, but must not add events that are not in the note.",
  "- Set eventDate only if the note states or clearly implies a date. Otherwise null.",
  "- Tags are short topics, one to five of them, capitalised.",
].join("\n");

export interface AiEnv {
  AI: Ai;
}

export type GenerationResult =
  | { status: "generated"; record: DraftRecord }
  | { status: "unavailable"; reason: "quota" | "invalid" | "error" };

/**
 * Workers AI signals an exhausted allowance through an error message rather
 * than a typed code, so this is pattern-matching and will need revisiting if
 * the wording changes. It only decides whether retrying is worth it, and the
 * fallback answer — treat it as a plain error, retry, then give up — is safe
 * either way.
 */
function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|capacity|rate.?limit|too many requests|\b429\b|limit exceeded/i.test(message);
}

/**
 * Workers AI returns the JSON already parsed when a schema constrains it, but
 * documents `response` as a string. Accept both rather than depending on which.
 */
function readResponse(output: unknown): unknown {
  const response = (output as { response?: unknown })?.response;
  if (typeof response !== "string") return response;

  try {
    return JSON.parse(response);
  } catch {
    return null;
  }
}

export async function generateRecord(
  env: AiEnv,
  text: string,
  today: Date = new Date(),
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<GenerationResult> {
  const userPrompt = [
    `Today is ${today.toISOString().slice(0, 10)}.`,
    "",
    "Note:",
    text,
  ].join("\n");

  // Remembers why the last attempt failed, so a model that is simply
  // unreachable is not reported as one producing malformed records.
  let failure: "invalid" | "error" = "error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let output: unknown;

    try {
      output = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_schema", json_schema: RECORD_JSON_SCHEMA },
        max_tokens: 1024,
        // Low but not zero: the same note should come back roughly the same
        // way, while Regenerate still has room to offer something different.
        temperature: 0.3,
      });
    } catch (error) {
      if (isQuotaError(error)) {
        // Retrying an exhausted allowance only burns the author's time. The
        // draft is already saved, so this is recoverable tomorrow.
        return { status: "unavailable", reason: "quota" };
      }
      // Constant string: a model error can quote the prompt back, and the
      // prompt contains what the author wrote.
      console.warn(`Workers AI call failed on attempt ${attempt}`);
      failure = "error";
      continue;
    }

    const record = parseRecord(readResponse(output));
    if (record !== null) return { status: "generated", record };

    console.warn(`Workers AI returned an unusable record on attempt ${attempt}`);
    failure = "invalid";
  }

  return { status: "unavailable", reason: failure };
}
