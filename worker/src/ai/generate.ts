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

const EDIT_SYSTEM_PROMPT = [
  "You are revising an entry for someone's personal website, following one instruction from its author.",
  "",
  "Rules:",
  "- Change only what the instruction asks for. Every other field comes back untouched.",
  "- The instruction is the author's, so follow it even where it contradicts your own judgement.",
  "- Never invent places, people, distances, times or achievements the entry does not already contain.",
  "- Keep the author's voice and first person.",
  "- Set eventDate only if the entry or the instruction states one. Otherwise null.",
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

/**
 * Low but not zero, so the same note comes back roughly the same way twice.
 * Regenerate deliberately runs hotter — see below.
 */
const STEADY = 0.3;

/**
 * Pressing Regenerate at the steady temperature would hand back something
 * almost identical, which reads as a broken button. The point of the request
 * is a different take on the same note.
 */
const VARIED = 0.9;

async function requestRecord(
  env: AiEnv,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxAttempts: number,
): Promise<GenerationResult> {
  // Remembers why the last attempt failed, so a model that is simply
  // unreachable is not reported as one producing malformed records.
  let failure: "invalid" | "error" = "error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let output: unknown;

    try {
      output = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_schema", json_schema: RECORD_JSON_SCHEMA },
        max_tokens: 1024,
        temperature,
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

function notePrompt(text: string, today: Date): string {
  return [`Today is ${today.toISOString().slice(0, 10)}.`, "", "Note:", text].join("\n");
}

export function generateRecord(
  env: AiEnv,
  text: string,
  today: Date = new Date(),
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<GenerationResult> {
  return requestRecord(env, SYSTEM_PROMPT, notePrompt(text, today), STEADY, maxAttempts);
}

/** Same note, another attempt at it — run hotter so the result is actually different. */
export function regenerateRecord(
  env: AiEnv,
  text: string,
  today: Date = new Date(),
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<GenerationResult> {
  return requestRecord(env, SYSTEM_PROMPT, notePrompt(text, today), VARIED, maxAttempts);
}

/**
 * Applies one instruction to the entry as it currently stands (spec §7.3).
 *
 * The current record goes in as data rather than as prose, so the model revises
 * a structure it can see rather than re-deriving one from a description of it.
 * `media` is left out: the model never decides media exists, and showing it a
 * media list invites it to return one.
 */
export function editRecord(
  env: AiEnv,
  record: DraftRecord,
  instruction: string,
  today: Date = new Date(),
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<GenerationResult> {
  const { media: _media, ...editable } = record;

  const userPrompt = [
    `Today is ${today.toISOString().slice(0, 10)}.`,
    "",
    "Current entry:",
    JSON.stringify(editable, null, 2),
    "",
    "Change to make:",
    instruction,
    "",
    "Apply only that change. Return the whole entry, with every other field exactly as it was.",
  ].join("\n");

  return requestRecord(env, EDIT_SYSTEM_PROMPT, userPrompt, STEADY, maxAttempts);
}
