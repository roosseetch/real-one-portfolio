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
import { intakeMedia, type MediaIntakeEnv } from "../media/intake";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import type { TelegramMessage, TelegramUpdate } from "../telegram/types";
import { applyEditInstruction, sendPreview, type ApprovalEnv } from "./approval";
import { takePendingEdit } from "./pending";
import { createDraft, loadDraft, saveDraft } from "./store";
import type { Draft } from "./types";

/** Spec §23, quoted rather than paraphrased. */
const AI_UNAVAILABLE_MESSAGE = "The draft has been saved. AI processing can continue later.";

const NOTHING_USABLE_MESSAGE =
  "I could not find anything to publish in that message. Send a note, a photo, or a video — a picture sent as a file works too.";

const UNUSABLE_FILE_MESSAGE =
  "I can only publish images and videos. That file is neither, so I have left it alone.";

export interface IntakeEnv extends AiEnv, TelegramApiEnv, ApprovalEnv, MediaIntakeEnv {
  PRIVATE_BUCKET: R2Bucket;
}

/**
 * Long enough for the rest of an album to arrive, short enough that the author
 * is not left wondering. Telegram delivers the items of a group within about a
 * second of each other; this waits past that before describing what arrived.
 */
const ALBUM_SETTLE_MS = 4000;

export type IntakeResult =
  | { status: "created"; draft: Draft }
  | { status: "unsupported" };

/**
 * Only a plain `message` starts a draft.
 *
 * `edited_message` deliberately does not: someone fixing a typo in Telegram
 * would otherwise get a second draft for the same thought. Editing a draft is
 * its own flow, driven by the buttons on the preview.
 *
 * Whatever arrives, the author hears back. A message this cannot use is
 * declined out loud rather than dropped: silence is indistinguishable from a
 * broken bot, and it leaves nothing behind to explain what happened.
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
  /** Lets an album keep collecting after the webhook has already answered. */
  waitUntil: (promise: Promise<unknown>) => void = () => {},
): Promise<IntakeResult> {
  const message = update.message;
  if (!message) {
    // An edited_message, or an update type the webhook does not subscribe to.
    // There is no chat to answer here, so the log is the only record.
    console.warn("Ignored a Telegram update carrying no message");
    return { status: "unsupported" };
  }

  if (message.photo || message.video || message.document) {
    return intakeMediaMessage(message, senderId, env, waitUntil);
  }

  const text = message.text?.trim();
  if (!text) {
    return decline(env, message, "no text and no usable media", NOTHING_USABLE_MESSAGE);
  }

  // Checked before anything else: after "Edit text" the author's next message
  // is the instruction, and it is indistinguishable from a new note otherwise.
  const edited = await applyPendingEdit(message.chat.id, text, env);
  if (edited) return edited;

  const draft = await createDraft(
    env.PRIVATE_BUCKET,
    { chatId: message.chat.id, senderId, messageId: message.message_id },
    text,
  );

  return describeAndPreview(env, draft, text);
}

/**
 * Files the media, then previews the draft it belongs to.
 *
 * Only the item that created the draft previews it. An album arrives as several
 * updates seconds apart, so the first one waits for the rest to land before
 * describing what the author actually sent — otherwise the preview shows one
 * photo of three, and re-previewing on each arrival would send three previews.
 */
async function intakeMediaMessage(
  message: TelegramMessage,
  senderId: number,
  env: IntakeEnv,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<IntakeResult> {
  const filed = await intakeMedia(message, senderId, env);
  if (filed.status === "unsupported") {
    // Only reachable via a document: photo and video are always usable, so this
    // is a file whose mime type is neither an image nor a video.
    const kind = message.document?.mime_type ?? "unknown";
    return decline(env, message, `a document of type ${kind}`, UNUSABLE_FILE_MESSAGE);
  }

  // A later item of an album: the first one owns the preview.
  if (filed.status === "appended") return { status: "created", draft: filed.draft };

  const draft = filed.draft;

  if (draft.mediaGroupId === null) {
    return describeAndPreview(env, draft, draft.input.text);
  }

  // Answer the webhook now and let the album settle in the background: holding
  // the response open for four seconds invites Telegram to redeliver.
  waitUntil(
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, ALBUM_SETTLE_MS));
      const settled = (await loadDraft(env.PRIVATE_BUCKET, draft.draftId)) ?? draft;
      if (settled.state !== "draft") return;
      await describeAndPreview(env, settled, settled.input.text);
    })(),
  );

  return { status: "created", draft };
}

/**
 * Answers a message the intake cannot turn into a draft.
 *
 * Every path that produces no draft comes through here, because returning 200
 * and saying nothing is what made a dropped message look like a dead bot — and
 * left no log either, so nothing recorded that anything had arrived.
 * `sendMessage` swallows its own transport failures, so this cannot throw and
 * turn a declined message into a 503 and a Telegram redelivery.
 */
async function decline(
  env: IntakeEnv,
  message: TelegramMessage,
  reason: string,
  reply: string,
): Promise<IntakeResult> {
  console.warn(`Declined a message: ${reason}`);
  await sendMessage(env, message.chat.id, reply);
  return { status: "unsupported" };
}

/** Asks the model for a record, stores it, and shows the author the result. */
async function describeAndPreview(env: IntakeEnv, draft: Draft, text: string): Promise<IntakeResult> {
  // A photo with no caption still deserves a record, so the model is given
  // something to work from rather than an empty prompt.
  const source = text.trim() === "" ? "A photo, with no caption. Describe only that it was shared." : text;
  const generated = await generateRecord(env, source);

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
