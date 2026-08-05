/**
 * Turns an authorized Telegram update into a stored draft (spec §7.1, steps
 * 2 and 3). Steps 4 onward — original media, Workers AI, the preview — belong
 * to later tasks; this is the point where an incoming message first becomes
 * something the system owns.
 */
import type { TelegramUpdate } from "../telegram/types";
import { createDraft } from "./store";
import type { Draft } from "./types";

export interface IntakeEnv {
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
export async function intakeUpdate(
  update: TelegramUpdate,
  senderId: number,
  env: IntakeEnv,
): Promise<IntakeResult> {
  const message = update.message;
  if (!message) return { status: "unsupported" };

  const text = message.text?.trim();
  if (!text) return { status: "unsupported" };

  const draft = await createDraft(
    env.PRIVATE_BUCKET,
    { chatId: message.chat.id, senderId, messageId: message.message_id },
    text,
  );

  return { status: "created", draft };
}
