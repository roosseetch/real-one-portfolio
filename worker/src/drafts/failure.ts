/**
 * What happens when a publication does not finish (spec §22–23).
 *
 * The author was told the link would follow. A draft left in `processing` with
 * no buttons is a promise nothing will ever keep, so every way a publication can
 * stop halfway ends here: the draft moves to `failed`, and the two things that
 * can still be done to it — run it again, or give up — arrive in the chat as
 * buttons.
 *
 * Nothing public is touched. A failed draft keeps its record, its originals and
 * its activity id, which is what lets a retry overwrite the half-written
 * derivatives of the previous attempt rather than leave a second set beside
 * them.
 */
import { randomId } from "../ids";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import { failureKeyboard } from "../telegram/preview";
import { transition } from "./state";
import { saveDraft } from "./store";
import type { Draft } from "./types";

/** Matches the approval loop's preview tokens: unguessable inside 64 bytes of callback_data. */
const TOKEN_LENGTH = 12;

/**
 * Where a publication stopped, as a closed set.
 *
 * A closed set because the wording below reaches a person's chat, and the only
 * thing that ever reports one is a workflow running third-party actions. Their
 * log lines are not something to paste in front of the author, and the stage is
 * all they would learn from one anyway.
 */
export const FAILURE_STAGES = [
  "dispatch",
  "download",
  "sanitize",
  "verify",
  "upload",
  "publish",
  "cancelled",
  "unknown",
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export function isFailureStage(value: unknown): value is FailureStage {
  return typeof value === "string" && (FAILURE_STAGES as readonly string[]).includes(value);
}

/** Spec §23, quoted rather than paraphrased. */
const HEADLINE = "Publication failed.";

/**
 * What the author is told about each stage.
 *
 * Every one of them says what did *not* happen, because that is the question a
 * failure raises: the site is unchanged and the draft is intact, whichever step
 * stopped.
 */
const STAGE_DETAIL: Record<FailureStage, string> = {
  dispatch: "The processing job could not be started, so nothing was touched.",
  download: "Your files could not be fetched for processing, so nothing was published.",
  sanitize:
    "The metadata could not be stripped off your media, and nothing half-cleaned is ever uploaded.",
  verify: "The processed media did not pass its checks, so none of it was uploaded.",
  upload: "The processed media could not be uploaded, so the site is unchanged.",
  publish: "The media is ready, but the entry itself could not be published.",
  cancelled: "The processing job was stopped before it finished. Nothing was published.",
  unknown: "The processing job did not finish. Nothing was published.",
};

const CLOSING = "The draft is still here — Retry runs it again from the start.";

export function failureMessage(stage: FailureStage): string {
  return `${HEADLINE} ${STAGE_DETAIL[stage]}\n\n${CLOSING}`;
}

export interface FailureEnv extends TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
}

/**
 * Moves a draft into `failed` and puts Retry and Cancel in front of the author.
 *
 * The state is written before the message is sent, and written again once the
 * message has an id: a draft that is durably `failed` with no live buttons can
 * still be reported on, while a live button whose token was never stored can
 * only be refused. That order is the same one `sendPreview` uses, for the same
 * reason.
 *
 * Returns false when the draft could not be stored. The caller is left to say
 * something; there is nothing else it can do.
 */
export async function failDraft(
  env: FailureEnv,
  draft: Draft,
  stage: FailureStage,
): Promise<boolean> {
  const token = randomId(TOKEN_LENGTH);
  const failed: Draft = {
    ...transition(draft, "failed"),
    // Whatever preview was on screen belonged to a decision that has already
    // been made. The token minted here is what the new buttons carry.
    preview: null,
    // `job` is deliberately kept. A straggling callback from the run that just
    // failed is already refused — a callback may only act on a draft that is
    // `processing`, and a retry mints a fresh token before it dispatches — while
    // dropping it would leave a second report of the same failure unable to
    // prove which job it came from, and so unable to be recognised as a repeat.
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, failed);
  } catch {
    console.error("Could not mark the draft as failed");
    return false;
  }

  const messageId = await sendMessage(
    env,
    draft.source.chatId,
    failureMessage(stage),
    failureKeyboard(draft.draftId, token),
  );

  if (messageId === null) {
    // The draft is safely `failed`; only the question failed to arrive. Left
    // without a preview, so nothing stale can be pressed, and recoverable for as
    // long as the bucket's seven-day rule keeps it.
    console.error("Could not tell the author that the publication failed");
    return true;
  }

  try {
    await saveDraft(env.PRIVATE_BUCKET, {
      ...failed,
      preview: { messageId, token },
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // The buttons are on screen carrying a token that was never stored, so they
    // will be refused as superseded rather than act on anything.
    console.error("Could not record the retry token; its buttons will not work");
  }

  return true;
}
