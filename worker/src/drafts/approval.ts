/**
 * The approval loop: send a preview, then act on the button that comes back
 * (spec §7.2, §22, §24).
 *
 * Every decision about what a callback may do is made here rather than at the
 * button, because a button lives in a Telegram message that outlives the state
 * it was drawn for. A press proves only that someone tapped something that was
 * true once.
 */
import { editRecord, regenerateRecord } from "../ai/generate";
import { toPublicRecord } from "../content/records";
import { timingSafeEqual } from "../crypto";
import { randomId } from "../ids";
import { resendsAsPhoto } from "../media/formats";
import { deletePublishedMedia } from "../media/published";
import { dispatchMediaProcessing, newJobToken, type DispatchEnv } from "../publishing/dispatch";
import {
  publishProcessedMedia,
  type MediaPublishEnv,
  type MediaPublishResult,
} from "../publishing/media-record";
import { publishRecord, type PublishEnv } from "../publishing/publish";
import { failDraft } from "./failure";
import { setPendingEdit } from "./pending";
import {
  answerCallback,
  removeKeyboard,
  sendDocument,
  sendMediaGroup,
  sendMessage,
  sendPhoto,
  type TelegramApiEnv,
} from "../telegram/api";
import {
  ACTION_CODES,
  formatPreview,
  hasPreviewableRecord,
  previewKeyboard,
  type PreviewAction,
} from "../telegram/preview";
import type { TelegramCallbackQuery } from "../telegram/types";
import { transition } from "./state";
import { loadDraft, saveDraft } from "./store";
import type { Draft, DraftRecord } from "./types";
import type { AiEnv } from "../ai/generate";

/** Long enough that guessing is hopeless, short enough for the 64-byte callback_data budget. */
const TOKEN_LENGTH = 12;

const CANCELLED_MESSAGE = "Cancelled. Nothing was published.";
const NOT_YET = "Not available yet.";
/** Telegram truncates any media caption past this, which would hide part of what is being approved. */
const MEDIA_CAPTION_LIMIT = 1024;
const EDIT_PROMPT = "What should change? Send it as a message, and the whole entry comes back for approval.";
/** Spec §23, quoted rather than paraphrased. */
const AI_UNAVAILABLE_MESSAGE = "The draft has been saved. AI processing can continue later.";
const PUBLISH_FAILED_MESSAGE = "Publication failed. The draft is still here — try again in a moment.";
/** Said when a retry stopped at the same place. The buttons are still live, so this is the whole reply. */
const RETRY_FAILED_MESSAGE = "That did not work either. The draft is still here — Retry when you want to try again.";
const PROCESSING_MESSAGE = "Processing the media. This takes a couple of minutes; the link follows when it is done.";

export interface ApprovalEnv extends TelegramApiEnv, AiEnv, PublishEnv, DispatchEnv, MediaPublishEnv {
  PRIVATE_BUCKET: R2Bucket;
  /**
   * Only ever deleted from, and only for a draft cancelled after its media was
   * already uploaded. Everything written there is written by GitHub Actions.
   */
  MEDIA_BUCKET: R2Bucket;
  /** Where the published record becomes visible, for the link sent back to the author. */
  SITE_BASE_URL: string;
}

/**
 * Sends the preview and records the token its buttons carry.
 *
 * Minting a fresh token every time is what retires the previous preview: after
 * a regeneration the older message is still sitting in the chat, and its
 * Publish button must not publish the text it is showing, which is no longer
 * what the draft says.
 */
export async function sendPreview(env: ApprovalEnv, draft: Draft): Promise<Draft> {
  if (!hasPreviewableRecord(draft)) return draft;

  const token = randomId(TOKEN_LENGTH);
  // Only when nothing survived: an album that lost one of four still publishes
  // the other three, and saying "none" there would be false.
  const text = formatPreview(draft.record, draft.mediaDeclined === true && draft.originals.length === 0);
  const keyboard = previewKeyboard(draft.draftId, token);
  const messageId = await sendPreviewMessages(env, draft, text, keyboard);

  // Nothing was shown, so nothing is awaiting approval. Leaving the draft alone
  // keeps it in a state a retry can still work from.
  if (messageId === null) return draft;

  const moved = draft.state === "draft" ? transition(draft, "awaiting_approval") : draft;
  const next: Draft = { ...moved, preview: { messageId, token }, updatedAt: new Date().toISOString() };

  try {
    await saveDraft(env.PRIVATE_BUCKET, next);
  } catch {
    // The preview is already on screen with a token that was never stored, so
    // its buttons will be refused as superseded. Not worth failing the turn
    // over: the author sees a preview and one dead press, rather than a
    // duplicate draft from a redelivered message.
    console.error("Could not record the preview token; its buttons will not work");
    return draft;
  }

  return next;
}

/**
 * Puts the preview on screen in whichever shape spec §7.2 calls for, and
 * returns the id of the message carrying the buttons.
 *
 * The originals are re-sent by Telegram file reference, so nothing is read back
 * out of R2 and, more importantly, no public object exists yet: approval is
 * what starts the media pipeline.
 */
async function sendPreviewMessages(
  env: ApprovalEnv,
  draft: Draft,
  text: string,
  keyboard: ReturnType<typeof previewKeyboard>,
): Promise<number | null> {
  const originals = draft.originals;

  if (originals.length === 0) {
    return sendMessage(env, draft.source.chatId, text, keyboard);
  }

  if (originals.length === 1) {
    // One item: the preview travels as the photo's caption, so the author sees
    // the picture and the words it would be published with together.
    const only = originals[0];
    if (only.type === "image" && text.length <= MEDIA_CAPTION_LIMIT) {
      // Skipped for a WebP rather than spent: Telegram treats that file
      // reference as a sticker and answers 400 to every one of them, so asking
      // bought a round trip and a `sendPhoto failed with status 400` warning on
      // a preview that then worked.
      if (resendsAsPhoto(only.key)) {
        const shown = await sendPhoto(env, draft.source.chatId, only.fileId, text, keyboard);
        if (shown !== null) return shown;
      }

      // Telegram will not re-send every file reference as a photo — a .webp
      // sent as a file is a sticker to it — but it takes the same reference as
      // an attachment, caption and buttons included. The author still sees the
      // picture next to the words it would be published with.
      const attached = await sendDocument(env, draft.source.chatId, only.fileId, text, keyboard);
      if (attached !== null) return attached;

      // Neither shape was accepted, which a sticker's own file reference can
      // do: it is re-sendable only through sendSticker, which carries no
      // caption. The picture is already safe in the private bucket and will
      // still be published, so the preview falls back to words rather than
      // leaving the author with nothing to approve.
      console.warn("Could not preview the image; falling back to a text preview");
      return sendMessage(env, draft.source.chatId, text, keyboard);
    }
  }

  // Several items, a video, or a caption too long for one: Telegram allows no
  // buttons on an album and caps a caption well below a message, so the media
  // goes first and a separate control message carries the full text and the
  // decision.
  await sendMediaGroup(
    env,
    draft.source.chatId,
    originals.map((original) => ({ type: original.type === "video" ? "video" : "photo", media: original.fileId })),
  );

  return sendMessage(env, draft.source.chatId, text, keyboard);
}

export interface ParsedCallback {
  action: PreviewAction;
  draftId: string;
  token: string;
}

/** `<code>:<draftId>:<token>`, rejected wholesale if it is anything else. */
export function parseCallbackData(data: string | undefined): ParsedCallback | null {
  if (!data) return null;

  const parts = data.split(":");
  if (parts.length !== 3) return null;

  const [code, draftId, token] = parts;
  const action = ACTION_CODES[code];
  if (!action || draftId === "" || token === "") return null;

  return { action, draftId, token };
}

/**
 * Handles one button press.
 *
 * Always answers the callback query, including on every rejection: Telegram
 * spins the button until something does, and a spinner that never stops reads
 * as a broken bot rather than a declined action.
 */
export async function handlePreviewCallback(
  query: TelegramCallbackQuery,
  env: ApprovalEnv,
): Promise<void> {
  const parsed = parseCallbackData(query.data);
  if (parsed === null) {
    await answerCallback(env, query.id, NOT_YET);
    return;
  }

  const draft = await loadDraft(env.PRIVATE_BUCKET, parsed.draftId);
  if (draft === null) {
    await answerCallback(env, query.id, "This draft is no longer available.");
    return;
  }

  // State before token, so a finished draft says what actually happened.
  // Acting on a terminal draft is refused either way, and "this preview has
  // been replaced" would send the author looking for a newer one that does not
  // exist. Nothing is given away by saying so: reaching here already required
  // an allowlisted sender and an unguessable draft id.
  //
  // A failed draft is the one state other than `awaiting_approval` that still
  // has live buttons, and it has exactly the two the failure message drew.
  const failedAction = parsed.action === "retry" || parsed.action === "cancel";
  const actionable =
    draft.state === "awaiting_approval" || (draft.state === "failed" && failedAction);

  if (!actionable) {
    await answerCallback(env, query.id, `Already ${draft.state.replace("_", " ")}.`);
    return;
  }

  // A press from a superseded preview, or from one whose token was never
  // stored. Either way the message it came from is not describing this draft.
  if (draft.preview === null || !timingSafeEqual(parsed.token, draft.preview.token)) {
    await answerCallback(env, query.id, "This preview has been replaced. Use the newest one.");
    return;
  }

  if (parsed.action === "cancel") {
    await cancelDraft(env, draft);
    await answerCallback(env, query.id, "Cancelled.");
    return;
  }

  if (parsed.action === "regenerate") {
    // Answered before the model runs: generation takes seconds, and Telegram
    // gives up on an unanswered callback long before that.
    await answerCallback(env, query.id, "Rewriting…");
    await regenerateDraft(env, draft);
    return;
  }

  if (parsed.action === "edit") {
    await answerCallback(env, query.id, "Send the change you want.");
    await setPendingEdit(env.PRIVATE_BUCKET, draft.source.chatId, draft.draftId);
    await sendMessage(env, draft.source.chatId, EDIT_PROMPT);
    return;
  }

  if (parsed.action === "retry") {
    // Only a failed draft has anything to run again. The button is drawn nowhere
    // else, so a press from a live preview is hand-made rather than something
    // the author could have tapped — and on a draft still awaiting approval it
    // would otherwise publish, which is not what the word says.
    if (draft.state !== "failed") {
      await answerCallback(env, query.id, NOT_YET);
      return;
    }

    // Answered first, like regenerate: a retry re-runs whatever failed, and
    // Telegram gives up on an unanswered callback long before a dispatch or a
    // manifest write comes back.
    await answerCallback(env, query.id, "Trying again…");
    await retryDraft(env, draft);
    return;
  }

  if (parsed.action === "publish") {
    await answerCallback(env, query.id, "Publishing…");
    await publishDraft(env, draft);
    return;
  }

  // Media lands with the photo pipeline. The buttons stay live rather than
  // being stripped, because nothing has been acted on yet.
  await answerCallback(env, query.id, NOT_YET);
}

/**
 * Publishes the approved record and retires the draft.
 *
 * The draft is marked published straight after the content write, and its
 * preview dropped, so the state check above refuses any later press. A record
 * already published short-circuits back to the link it produced: chunks are
 * immutable, so a duplicate could not simply be edited out afterwards.
 */
async function publishDraft(env: ApprovalEnv, draft: Draft): Promise<void> {
  if (draft.record === null) return;

  if (draft.published !== null) {
    await sendMessage(env, draft.source.chatId, `Already published. ${draft.published.url}`);
    return;
  }

  // Already sanitised, and shown to the author because the transcode changed it
  // visibly. This press is the confirmation, so it publishes from the files the
  // pipeline produced rather than asking for the work a second time.
  const processed = draft.processed ?? null;
  if (processed !== null) {
    const result = await publishProcessedMedia(env, draft, processed.media);

    if (result.status !== "published") {
      await sendMessage(env, draft.source.chatId, PUBLISH_FAILED_MESSAGE);
      return;
    }

    if (draft.preview !== null) {
      await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
    }
    return;
  }

  // Media goes the long way round: the files have to be stripped of their
  // metadata before anything of them becomes public, and that happens in a
  // GitHub Actions runner rather than here (spec §10.2).
  if (draft.originals.length > 0) {
    await startMediaProcessing(env, draft);
    return;
  }

  const result = await publishTextRecord(env, draft);

  if (result.status !== "published") {
    // The draft is left in `awaiting_approval` with its buttons still on screen,
    // so pressing Publish again is the retry. Nothing was dispatched and nothing
    // is half-done, which is what makes that safe here and not on the media path.
    await sendMessage(env, draft.source.chatId, PUBLISH_FAILED_MESSAGE);
    return;
  }

  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }
}

/**
 * Writes a record with no media, retires the draft, and sends the link.
 *
 * Shaped like `publishProcessedMedia` — same result, same message, same
 * bookkeeping — so the callers that can reach either one do not have to care
 * which they got.
 */
async function publishTextRecord(env: ApprovalEnv, draft: Draft): Promise<MediaPublishResult> {
  if (draft.record === null) return { status: "failed" };

  const result = await publishRecord(env, toPublicRecord(draft.record));
  if (result.status !== "published") return { status: "failed" };

  const url = `${env.SITE_BASE_URL.replace(/\/$/, "")}/#activity`;
  const published: Draft = {
    ...transition(draft, "published"),
    preview: null,
    published: { recordId: result.record.id, url },
    updatedAt: new Date().toISOString(),
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, published);
  } catch {
    // The record is live; only the bookkeeping failed. The caller strips the
    // keyboard, which is what stops a second press from publishing it twice, so
    // say nothing to the author about a problem that no longer affects them.
    console.error("Published, but could not record it on the draft");
  }

  await sendMessage(env, draft.source.chatId, `Published. ${url}`);
  return { status: "published", url };
}

/**
 * Runs a failed publication again (spec §23).
 *
 * The same draft and the same activity id, deliberately: every derivative's name
 * is built from the activity id, so a second run overwrites whatever the first
 * one half-wrote instead of leaving an orphaned set beside it. The job token is
 * the one thing minted fresh, which is what stops a straggling run from the
 * previous attempt reporting against this one.
 *
 * How much is repeated depends on how far the first attempt got. Media that was
 * already sanitised and uploaded is not sanitised again — the files are in the
 * public bucket and asking for them a second time would only produce identical
 * ones.
 */
async function retryDraft(env: ApprovalEnv, draft: Draft): Promise<void> {
  if (draft.published !== null) {
    await sendMessage(env, draft.source.chatId, `Already published. ${draft.published.url}`);
    return;
  }

  const processed = draft.processed ?? null;

  // Nothing survived the first attempt, so the whole job runs again.
  // startMediaProcessing is what moves the draft back into `processing`, and it
  // leaves the buttons alone until that write has landed.
  if (processed === null && draft.originals.length > 0) {
    await startMediaProcessing(env, draft);
    return;
  }

  // Either the media is already sanitised or there never was any: what failed
  // was the write that makes the record public, and that is all that repeats.
  // Back through `processing` first so a second press finds a draft that is
  // already running rather than starting a second publication.
  const resuming: Draft = { ...transition(draft, "processing"), preview: null, job: null };

  try {
    await saveDraft(env.PRIVATE_BUCKET, resuming);
  } catch {
    // Still `failed` in the bucket with its buttons live, so the next press is
    // another retry rather than nothing at all.
    console.error("Could not mark the draft as retrying; nothing was published");
    await sendMessage(env, draft.source.chatId, RETRY_FAILED_MESSAGE);
    return;
  }

  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }

  const result =
    processed !== null
      ? await publishProcessedMedia(env, resuming, processed.media)
      : await publishTextRecord(env, resuming);

  if (result.status !== "published") {
    // Back to `failed` with a fresh pair of buttons, rather than stranded in
    // `processing` with nothing running and nothing to press.
    await failDraft(env, resuming, "publish");
  }
}

/**
 * Rewrites the entry from the author's original note and previews it again.
 *
 * Always from `input.text`, never from the record currently on the draft:
 * regenerating from the last generation would compound its drift, so each
 * attempt starts from what the author actually wrote.
 */
async function regenerateDraft(env: ApprovalEnv, draft: Draft): Promise<void> {
  const generated = await regenerateRecord(env, draft.input.text, draft.record);

  if (generated.status !== "generated") {
    await sendMessage(env, draft.source.chatId, AI_UNAVAILABLE_MESSAGE);
    return;
  }

  await replaceRecord(env, draft, generated.record);
}

/** Applies one instruction to the draft and previews the whole result again. */
export async function applyEditInstruction(
  env: ApprovalEnv,
  draft: Draft,
  instruction: string,
): Promise<void> {
  if (draft.record === null) return;

  const edited = await editRecord(env, draft.record, instruction);

  if (edited.status !== "generated") {
    await sendMessage(env, draft.source.chatId, AI_UNAVAILABLE_MESSAGE);
    return;
  }

  await replaceRecord(env, draft, edited.record);
}

/**
 * Stores a revised record and shows the whole preview again.
 *
 * Spec §7.3 is explicit that the complete preview follows every change rather
 * than the changed field alone: approving a diff is not approving what becomes
 * public. sendPreview mints a new token, which is what stops the superseded
 * message from publishing text the draft no longer says.
 */
async function replaceRecord(env: ApprovalEnv, draft: Draft, record: DraftRecord): Promise<void> {
  const updated: Draft = { ...draft, record, updatedAt: new Date().toISOString() };

  try {
    await saveDraft(env.PRIVATE_BUCKET, updated);
  } catch {
    console.error("Could not store the revised record; the previous version still stands");
    await sendMessage(env, draft.source.chatId, "That change could not be saved. The previous version still stands.");
    return;
  }

  // The old preview's buttons are retired by the new token, but leaving the
  // keyboard on screen invites a press that can only be refused.
  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }

  await sendPreview(env, updated);
}

/**
 * Moves the draft into `processing` and asks GitHub Actions to sanitise it.
 *
 * The state is written before the dispatch. A draft marked `processing` with no
 * job running is recoverable — the failure flows retry it — whereas a job
 * running against a draft that still says `awaiting_approval` would publish
 * behind the author's back.
 */
async function startMediaProcessing(env: ApprovalEnv, draft: Draft): Promise<void> {
  const jobToken = newJobToken();
  const processing: Draft = {
    ...transition(draft, "processing"),
    // The buttons go with the preview: there is nothing left to decide until
    // the media comes back.
    preview: null,
    job: { jobToken, dispatchedAt: new Date().toISOString() },
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, processing);
  } catch {
    console.error("Could not mark the draft as processing; nothing was dispatched");
    await sendMessage(env, draft.source.chatId, PUBLISH_FAILED_MESSAGE);
    return;
  }

  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }

  const dispatched = await dispatchMediaProcessing(env, draft.draftId, jobToken);

  if (!dispatched) {
    // Nothing is running, and nothing ever will be: no workflow started, so no
    // workflow can report this. Marking it failed here is what puts the Retry
    // button on screen — left in `processing` the draft would sit there with no
    // job and no buttons, after the author was told a link would follow.
    await failDraft(env, processing, "dispatch");
    return;
  }

  await sendMessage(env, draft.source.chatId, PROCESSING_MESSAGE);
}

async function cancelDraft(env: ApprovalEnv, draft: Draft): Promise<void> {
  const cancelled: Draft = {
    ...transition(draft, "cancelled"),
    // Dropping the preview retires its buttons even if the message edit below
    // fails, so a second press cannot find a live token to match.
    preview: null,
  };

  await saveDraft(env.PRIVATE_BUCKET, cancelled);

  // Cancelled after the pipeline had already uploaded: the files are in the
  // public bucket, unreferenced by any record or manifest, and the author has
  // just said no to them. Unreachable is not the same as gone.
  //
  // A failed draft is swept for the same reason without knowing whether there is
  // anything to sweep. The upload step runs before the callback, so a run that
  // stopped after it left a complete set behind; one that stopped during it left
  // part of a set. Listing an empty prefix costs one call and answers both.
  if ((draft.processed ?? null) !== null || draft.state === "failed") {
    await deletePublishedMedia(env.MEDIA_BUCKET, draft.activityId);
  }

  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }
  await sendMessage(env, draft.source.chatId, CANCELLED_MESSAGE);

  // The draft itself is left for the bucket's lifecycle rule to remove, which
  // is what makes a cancellation recoverable for seven days.
}
