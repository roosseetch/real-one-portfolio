/**
 * Turns an authorized Telegram update into a stored draft, then asks Workers AI
 * for the record to propose (spec §7.1, steps 2, 3 and 5). Original media and
 * the preview itself belong to later tasks.
 *
 * The draft is written before the model is called, and that order is the whole
 * design: if generation fails, the author's words are already safe in R2 and
 * the work can be picked up later.
 */
import { generateRecord, type AiEnv } from "../ai/generate";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import type { TelegramUpdate } from "../telegram/types";
import { applyEditInstruction, sendPreview, type ApprovalEnv } from "./approval";
import { takePendingEdit } from "./pending";
import { createDraft, loadDraft, saveDraft } from "./store";
import type { Draft } from "./types";

/** Spec §23, quoted rather than paraphrased. */
const AI_UNAVAILABLE_MESSAGE = "The draft has been saved. AI processing can continue later.";

export interface IntakeEnv extends AiEnv, TelegramApiEnv, ApprovalEnv {
  PRIVATE_BUCKET: R2Bucket;
}

export type IntakeResult =
  | { status: "created"; draft: Draft }
  | { status: "unsupported" };

/**
 * Only a plain `message` starts a draft.
 *
 * `edited_message` deliberately does not: someone fixing a typo in Telegram
 * would otherwise get a second draft for the same thought. Editing a draft is
 * its own flow, driven by the buttons on the preview. Photos and videos are
 * likewise left alone until the media pipeline exists to sanitize them — until
 * then there is nowhere safe for the file to go.
 */
/**
 * Consumes a pending edit instruction, if this chat owes one.
 *
 * Returns null when the message is an ordinary new note. The pointer is taken
 * — read and cleared — before the draft is checked, so a pointer to a draft
 * that has since been cancelled or published cannot keep intercepting messages.
 */
async function applyPendingEdit(
  chatId: number,
  text: string,
  env: IntakeEnv,
): Promise<IntakeResult | null> {
  const draftId = await takePendingEdit(env.PRIVATE_BUCKET, chatId);
  if (draftId === null) return null;

  const draft = await loadDraft(env.PRIVATE_BUCKET, draftId);

  // The draft moved on while the author was typing. Treating the message as an
  // instruction would silently discard it, so it starts a new draft instead.
  if (draft === null || draft.state !== "awaiting_approval" || draft.record === null) return null;

  await applyEditInstruction(env, draft, text);
  return { status: "created", draft };
}

export async function intakeUpdate(
  update: TelegramUpdate,
  senderId: number,
  env: IntakeEnv,
): Promise<IntakeResult> {
  const message = update.message;
  if (!message) return { status: "unsupported" };

  const text = message.text?.trim();
  if (!text) return { status: "unsupported" };

  // Checked before anything else: after "Edit text" the author's next message
  // is the instruction, and it is indistinguishable from a new note otherwise.
  const edited = await applyPendingEdit(message.chat.id, text, env);
  if (edited) return edited;

  const draft = await createDraft(
    env.PRIVATE_BUCKET,
    { chatId: message.chat.id, senderId, messageId: message.message_id },
    text,
  );

  const generated = await generateRecord(env, text);

  if (generated.status === "generated") {
    const withRecord: Draft = { ...draft, record: generated.record, updatedAt: new Date().toISOString() };
    try {
      await saveDraft(env.PRIVATE_BUCKET, withRecord);

      // sendPreview is what moves the draft to awaiting_approval: there is
      // nothing to approve until the author has actually seen it.
      return { status: "created", draft: await sendPreview(env, withRecord) };
    } catch {
      // Deliberately swallowed, unlike the first write. Once a draft exists,
      // letting this throw would answer 503, and Telegram would redeliver the
      // same message into a second draft for the same thought. Losing the
      // generated record costs a regeneration; a duplicate draft costs trust in
      // what the bot does with a message.
      console.error("Could not store the generated record; the draft is saved without it");
    }
  }

  // Reached whether the model was unavailable or its record could not be
  // stored. Both leave the same recoverable draft, and the author can do the
  // same thing about either, so they are told the same thing.
  await sendMessage(env, draft.source.chatId, AI_UNAVAILABLE_MESSAGE);
  return { status: "created", draft };
}
