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
import { publishRecord, type PublishEnv } from "../publishing/publish";
import { setPendingEdit } from "./pending";
import {
  answerCallback,
  removeKeyboard,
  sendMessage,
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
const EDIT_PROMPT = "What should change? Send it as a message, and the whole entry comes back for approval.";
/** Spec §23, quoted rather than paraphrased. */
const AI_UNAVAILABLE_MESSAGE = "The draft has been saved. AI processing can continue later.";
const PUBLISH_FAILED_MESSAGE = "Publication failed. The draft is still here — try again in a moment.";

export interface ApprovalEnv extends TelegramApiEnv, AiEnv, PublishEnv {
  PRIVATE_BUCKET: R2Bucket;
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
  const messageId = await sendMessage(
    env,
    draft.source.chatId,
    formatPreview(draft.record),
    previewKeyboard(draft.draftId, token),
  );

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
  if (draft.state !== "awaiting_approval") {
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

  const result = await publishRecord(env, toPublicRecord(draft.record));

  if (result.status !== "published") {
    await sendMessage(env, draft.source.chatId, PUBLISH_FAILED_MESSAGE);
    return;
  }

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
    // The record is live; only the bookkeeping failed. Stripping the keyboard
    // below is what stops a second press from publishing it twice, so say
    // nothing to the author about a problem that no longer affects them.
    console.error("Published, but could not record it on the draft");
  }

  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }
  await sendMessage(env, draft.source.chatId, `Published. ${url}`);
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

async function cancelDraft(env: ApprovalEnv, draft: Draft): Promise<void> {
  const cancelled: Draft = {
    ...transition(draft, "cancelled"),
    // Dropping the preview retires its buttons even if the message edit below
    // fails, so a second press cannot find a live token to match.
    preview: null,
  };

  await saveDraft(env.PRIVATE_BUCKET, cancelled);

  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }
  await sendMessage(env, draft.source.chatId, CANCELLED_MESSAGE);

  // The draft itself is left for the bucket's lifecycle rule to remove, which
  // is what makes a cancellation recoverable for seven days.
}
