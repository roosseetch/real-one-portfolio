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
import { promptForActivity, type RepostEnv } from "../linkedin/repost";
import {
  applyAttachTarget,
  promptForAttachTarget,
  type AttachMediaEnv,
} from "../media/attach";
import { applyDetachTarget, promptForRemoval, type DetachEnv } from "../media/detach";
import { carriesMedia, intakeMedia, type DeclineReason, type MediaIntakeEnv } from "../media/intake";
import type { FileLabel } from "../media/formats";
import {
  applyDeleteTarget,
  promptForDeletion,
  type DeleteActivityEnv,
} from "../publishing/delete-activity";
import {
  applyEditTarget,
  applyEditValue,
  promptForEdit,
  type EditActivityEnv,
} from "../publishing/edit-activity";
import { findAlbumDraft } from "./albums";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import {
  ADD_MEDIA_PROMPT,
  MAIN_KEYBOARD,
  NEW_ACTIVITY_PROMPT,
  RAW_PROMPT,
  WELCOME,
  menuAction,
  type MenuAction,
} from "../telegram/menu";
import type { TelegramMessage, TelegramUpdate } from "../telegram/types";
import {
  applyEditInstruction,
  sendGenerationFailure,
  sendPreview,
  type ApprovalEnv,
} from "./approval";
import {
  clearPending,
  setPendingAttach,
  setPendingVerbatim,
  takePending,
  takePendingAttach,
} from "./pending";
import { createDraft, loadDraft, saveDraft } from "./store";
import type { Draft } from "./types";
import { verbatimRecord } from "./verbatim";

const NOTHING_USABLE_MESSAGE =
  "I could not find anything to publish in that message. Send a note, a photo, or a video — a picture sent as a file works too, and so does a sticker.";

const UNUSABLE_FILE_MESSAGE =
  "I can only publish images and videos. That file is neither, so I have left it alone.";

/** What the sanitiser can open, quoted back so "send it as something else" is actionable. */
const OPENABLE_IMAGES = "JPEG, PNG, WebP, GIF, TIFF and BMP";
const OPENABLE_VIDEO = "MP4, MOV and WebM";

/**
 * What Telegram actually said the file was, appended to every refusal of one.
 *
 * The first time this broke, the reply named nothing and the decline answered
 * 200 — which `flush` does not persist — so the chat and the log between them
 * recorded only that something had been refused, not what. Quoting the type and
 * the name means the next one is diagnosable from the chat alone.
 */
function fileNote(file: FileLabel): string {
  const type = file.mime ?? "no type at all";
  return file.name ? `\n\nTelegram called it: ${type} — "${file.name}"` : `\n\nTelegram called it: ${type}`;
}

/** Bytes as the author thinks of them. One decimal: "20.0 MB" is the limit they were told. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Every refusal the media path can produce, in one place so the voice stays one voice. */
export function declineMessage(reason: DeclineReason): string {
  switch (reason.kind) {
    case "not-media":
      return `${UNUSABLE_FILE_MESSAGE}${fileNote(reason.file)}`;

    case "unopenable": {
      const openable = reason.mediaKind === "video" ? OPENABLE_VIDEO : OPENABLE_IMAGES;
      const noun = reason.mediaKind === "video" ? "video" : "pictures";
      return (
        `I can publish ${openable} ${noun}. That one is ${reason.format}, which I cannot open, so I have left it alone. ` +
        `Sending it again as a JPEG will work.${fileNote(reason.file)}`
      );
    }

    case "sticker-moves":
      return (
        `That is a ${reason.video ? "video" : "animated"} sticker, and I can only publish still pictures. ` +
        "A sticker that does not move works, and so does a photo."
      );

    case "contents": {
      const found = reason.format === null ? "not one" : `a ${reason.format}`;
      return (
        `That file is named like a picture, but its contents are ${found}. I checked the first bytes and ` +
        `left it alone rather than hand the publisher something that would only fail later.${fileNote(reason.file)}`
      );
    }

    case "too-large": {
      const noun = reason.mediaKind === "video" ? "video" : "file";
      return (
        `That ${noun} is ${megabytes(reason.bytes)}, and Telegram only lets a bot download files up to ` +
        `${megabytes(reason.limit)}. I never received the bytes, so there is nothing to publish. A shorter ` +
        `clip, or the same one sent at a lower quality, will come through.`
      );
    }
  }
}

export interface IntakeEnv
  extends AiEnv,
    TelegramApiEnv,
    ApprovalEnv,
    MediaIntakeEnv,
    RepostEnv,
    AttachMediaEnv,
    DetachEnv,
    DeleteActivityEnv,
    EditActivityEnv {
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
 * Consumes whatever this chat's next message was promised to, if anything.
 *
 * Returns null when the message is an ordinary new note. The pointer is taken
 * — read and cleared — before the draft is checked, so a pointer to a draft
 * that has since been cancelled or published cannot keep intercepting messages.
 */
async function applyPending(
  chatId: number,
  senderId: number,
  messageId: number,
  text: string,
  env: IntakeEnv,
): Promise<IntakeResult | null> {
  const pending = await takePending(env.PRIVATE_BUCKET, chatId);
  if (pending === null) return null;

  if (pending.kind === "verbatim") {
    return publishAsWritten(env, { chatId, senderId, messageId }, text);
  }

  // The author pressed "Add media" and then sent words instead of a file. There
  // is nothing filed to attach, so this is a new note — but the pointer has to
  // be consumed rather than left to swallow the message after next.
  if (pending.kind === "attach") return null;

  if (pending.kind === "detach-target") {
    await applyDetachTarget(env, chatId, text);
    return { status: "unsupported" };
  }

  if (pending.kind === "delete-target") {
    await applyDeleteTarget(env, chatId, text);
    return { status: "unsupported" };
  }

  if (pending.kind === "edit-target") {
    await applyEditTarget(env, chatId, text);
    return { status: "unsupported" };
  }

  // The one pointer whose message is the content rather than a reference to it:
  // this text becomes a field of a published record, untouched.
  if (pending.kind === "edit-field") {
    await applyEditValue(env, chatId, pending.recordId, pending.field, text);
    return { status: "unsupported" };
  }

  const draft = await loadDraft(env.PRIVATE_BUCKET, pending.draftId);

  if (pending.kind === "attach-target") {
    // Same rule as the edit below: a draft that has moved on since the button
    // was pressed leaves the message to be an ordinary note rather than having
    // it silently discarded.
    if (draft === null) return null;
    return (await applyAttachTarget(env, draft, text)) ? { status: "unsupported" } : null;
  }

  // The draft moved on while the author was typing. Treating the message as an
  // instruction would silently discard it, so it starts a new draft instead.
  if (draft === null || draft.state !== "awaiting_approval" || draft.record === null) return null;

  await applyEditInstruction(env, draft, text);
  return { status: "created", draft };
}

/**
 * Turns the author's message into a draft without asking a model anything.
 *
 * Same draft, same bucket, same preview and the same Publish button as every
 * other note — the only difference is where the record comes from, which is
 * `verbatimRecord` and therefore the author. Approval is not skipped along with
 * the model: seeing what will become public before it does is the point of the
 * preview, and it does not stop being the point because nobody rewrote it.
 */
async function publishAsWritten(
  env: IntakeEnv,
  source: { chatId: number; senderId: number; messageId: number },
  text: string,
): Promise<IntakeResult> {
  const record = verbatimRecord(text);

  // The menu action guards against an empty message before it ever gets here,
  // so this is the belt to that braces.
  if (record === null) {
    await sendMessage(env, source.chatId, NOTHING_USABLE_MESSAGE);
    return { status: "unsupported" };
  }

  const draft = await createDraft(env.PRIVATE_BUCKET, source, text);
  const withRecord: Draft = { ...draft, record, updatedAt: new Date().toISOString() };

  try {
    await saveDraft(env.PRIVATE_BUCKET, withRecord);
  } catch {
    // Swallowed for the reason describeAndPreview swallows its own: the draft
    // exists, and a 503 here would have Telegram redeliver the note into a
    // second draft for the same thought. Nothing was lost that a press of
    // "Use my text" on the preview cannot put back.
    console.error("Could not store the verbatim record; the draft is saved without it");
    await sendGenerationFailure(env, draft);
    return { status: "created", draft };
  }

  return { status: "created", draft: await sendPreview(env, withRecord) };
}

/**
 * Runs one of the standing buttons, or its command.
 *
 * The pending edit is cleared first, on every action. Taking a button means the
 * author has moved on from whatever they were editing, and leaving the pointer
 * in place would have their next real message silently rewrite a draft they had
 * stopped thinking about.
 *
 * "New site activity" has nothing to start: the flow is, and always was, "send a
 * message". So it prompts and gets out of the way rather than inventing a state
 * the rest of the intake would have to know about.
 */
async function runMenuAction(env: IntakeEnv, chatId: number, action: MenuAction): Promise<void> {
  await clearPending(env.PRIVATE_BUCKET, chatId);

  if (action === "repost") {
    await promptForActivity(env, chatId);
    return;
  }

  // Nothing is armed here: removing media starts from a list of activities, and
  // the files to choose from are on whichever one is picked.
  if (action === "removemedia") {
    await promptForRemoval(env, chatId);
    return;
  }

  // This one does arm, and arms itself: the flow is built around the author
  // pasting the link of the entry they want gone, so the answer has to be
  // typeable without a button being pressed first.
  if (action === "deleteactivity") {
    await promptForDeletion(env, chatId);
    return;
  }

  // Armed the same way as deleting, and for the same reason: the flow starts
  // from the link of something already published.
  if (action === "editactivity") {
    await promptForEdit(env, chatId);
    return;
  }

  // Armed rather than done: the note itself is the next message, exactly as
  // "Edit text" leaves the instruction to be the next one.
  if (action === "raw") {
    await setPendingVerbatim(env.PRIVATE_BUCKET, chatId);
    await sendMessage(env, chatId, RAW_PROMPT);
    return;
  }

  // Armed the same way, and for the same reason: what follows is a photo rather
  // than a note, and a photo sent to this bot has always meant "write me an
  // activity about this". The pointer is the only thing that says otherwise.
  if (action === "addmedia") {
    await setPendingAttach(env.PRIVATE_BUCKET, chatId);
    await sendMessage(env, chatId, ADD_MEDIA_PROMPT);
    return;
  }

  // The keyboard rides along with the reply, which is also how it first appears:
  // /start is what an author sends a bot they have never used.
  await sendMessage(
    env,
    chatId,
    action === "start" ? WELCOME : NEW_ACTIVITY_PROMPT,
    MAIN_KEYBOARD,
  );
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

  if (carriesMedia(message)) {
    return intakeMediaMessage(message, senderId, env, waitUntil, await attaching(env, message));
  }

  const text = message.text?.trim();
  if (!text) {
    return decline(env, message, "no text and no usable media", NOTHING_USABLE_MESSAGE);
  }

  // Before the pending edit, and before anything becomes a draft. A reply
  // keyboard sends its own label as an ordinary message, so without this,
  // pressing "Repost to LinkedIn" while an edit was outstanding would rewrite
  // the draft to say "Repost to LinkedIn".
  const action = menuAction(text);
  if (action !== null) {
    await runMenuAction(env, message.chat.id, action);
    return { status: "unsupported" };
  }

  // Checked before anything else that could make a draft: after "Edit text" the
  // author's next message is the instruction, and after "Publish as written" it
  // is the note to use untouched. Both are indistinguishable from a new note.
  const promised = await applyPending(message.chat.id, senderId, message.message_id, text, env);
  if (promised) return promised;

  const draft = await createDraft(
    env.PRIVATE_BUCKET,
    { chatId: message.chat.id, senderId, messageId: message.message_id },
    text,
  );

  return describeAndPreview(env, draft, text);
}

/**
 * Whether this message's files were promised to an activity that already exists.
 *
 * The pointer is consumed here, once, by the item that will create the draft —
 * an album's later items find that draft through its media group id and inherit
 * the answer from it, so taking the pointer per item would have the second photo
 * of three start a second, unattached draft.
 *
 * Only an "attach" pointer is touched. An outstanding edit instruction or a
 * promised verbatim note is left exactly where it is: neither has anything to do
 * with a photo, and clearing one here would silently swallow it.
 */
async function attaching(env: IntakeEnv, message: TelegramMessage): Promise<boolean> {
  const groupId = message.media_group_id ?? null;
  if (groupId !== null && (await findAlbumDraft(env.PRIVATE_BUCKET, groupId)) !== null) return false;

  return takePendingAttach(env.PRIVATE_BUCKET, message.chat.id);
}

/**
 * Puts the "Add media" pointer back after a file that never became one.
 *
 * The pointer is spent by the time the file is refused, so without this the
 * author presses the button, sends something the publisher cannot open, is told
 * why — and their next photo quietly becomes a new activity instead. Only for a
 * refusal that left no draft behind: once one exists, its siblings find it.
 */
async function rearm(env: IntakeEnv, message: TelegramMessage, attachment: boolean): Promise<void> {
  if (!attachment) return;
  await setPendingAttach(env.PRIVATE_BUCKET, message.chat.id);
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
  attachment: boolean,
): Promise<IntakeResult> {
  const filed = await intakeMedia(message, senderId, env, attachment);

  // The gate said the message carried media, so this is a field carrying
  // nothing usable at all rather than an empty message.
  if (filed.status === "none") {
    await rearm(env, message, attachment);
    return decline(env, message, "media fields carrying no file", NOTHING_USABLE_MESSAGE);
  }

  // Refused on what the file claimed to be, before any download and before any
  // draft: nothing is left behind to clean up.
  if (filed.status === "declined") {
    await rearm(env, message, attachment);
    return decline(env, message, describeReason(filed.reason), declineMessage(filed.reason));
  }

  // Refused on its contents, after the draft was made. The draft stands — its
  // siblings in an album are fine — but the author is told which file went.
  if (filed.declined !== null) {
    await say(env, message, describeReason(filed.declined), declineMessage(filed.declined));
  }

  // A later item of an album: the first one owns the preview.
  if (filed.status === "appended") return { status: "created", draft: filed.draft };

  const draft = filed.draft;

  if (draft.mediaGroupId === null) {
    // The one file this message carried was refused and there were no words
    // either, so there is nothing to put in front of the author. Previewing
    // would ask them to approve an empty record; the draft is left for the
    // seven-day lifecycle rule, like any other abandoned one.
    if (draft.originals.length === 0 && draft.input.text.trim() === "") {
      return { status: "unsupported" };
    }
    return settle(env, draft);
  }

  // Answer the webhook now and let the album settle in the background: holding
  // the response open for four seconds invites Telegram to redeliver. This runs
  // even when this item was refused — the siblings still need someone to
  // preview them, and only the item that made the draft is here to do it.
  waitUntil(
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, ALBUM_SETTLE_MS));
      const settled = (await loadDraft(env.PRIVATE_BUCKET, draft.draftId)) ?? draft;
      if (settled.state !== "draft") return;
      if (settled.originals.length === 0 && settled.input.text.trim() === "") return;
      await settle(env, settled);
    })(),
  );

  return { status: "created", draft };
}

/**
 * What happens once everything a message was going to bring has arrived.
 *
 * The two answers are the two things a photo can mean here. An ordinary draft
 * gets a record written for it and a preview to approve; files promised to an
 * activity that already exists get the only question that flow has to ask, which
 * is which activity — there is no entry to propose, so the model is never
 * called.
 */
async function settle(env: IntakeEnv, draft: Draft): Promise<IntakeResult> {
  if ((draft.attachment ?? null) !== null) {
    return { status: "created", draft: await promptForAttachTarget(env, draft) };
  }

  return describeAndPreview(env, draft, draft.input.text);
}

/** The log's version of a refusal: short, literal, and never the author's words. */
function describeReason(reason: DeclineReason): string {
  switch (reason.kind) {
    case "not-media":
      return `a document of type ${reason.file.mime ?? "unknown"}`;
    case "unopenable":
      return `a ${reason.format} the publisher cannot open`;
    case "sticker-moves":
      return reason.video ? "a video sticker" : "an animated sticker";
    case "contents":
      return `a file whose contents are ${reason.format ?? "unrecognised"}`;
    case "too-large":
      return `a ${reason.bytes}-byte ${reason.mediaKind} past the Bot API's ${reason.limit}-byte ceiling`;
  }
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
  await say(env, message, reason, reply);
  return { status: "unsupported" };
}

/**
 * Records a refusal and tells the author, without ending the turn.
 *
 * A file rejected on its contents needs both halves of `decline` but not its
 * verdict: the draft it belonged to is still going to be previewed.
 *
 * `console.error` rather than `warn` on purpose. A decline answers 200, and
 * `flush` keeps warnings only as context around an error — so the first time
 * this happened it left no durable record at all, which is most of why the
 * cause had to be inferred from the source rather than read off a log. Only an
 * allowlisted sender can reach this, so nobody outside can drive it.
 */
async function say(
  env: IntakeEnv,
  message: TelegramMessage,
  reason: string,
  reply: string,
): Promise<void> {
  console.error(`Declined a message: ${reason}`);
  await sendMessage(env, message.chat.id, reply);
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
  // same thing about either, so they are told the same thing — and given the
  // button that makes "later" a press rather than retyping the whole note.
  await sendGenerationFailure(env, draft);
  return { status: "created", draft };
}
