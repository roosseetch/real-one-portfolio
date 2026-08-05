/**
 * The approval loop: send a preview, then act on the button that comes back
 * (spec §7.2, §22, §24).
 *
 * Every decision about what a callback may do is made here rather than at the
 * button, because a button lives in a Telegram message that outlives the state
 * it was drawn for. A press proves only that someone tapped something that was
 * true once.
 */
import { timingSafeEqual } from "../crypto";
import { randomId } from "../ids";
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
import type { Draft } from "./types";

/** Long enough that guessing is hopeless, short enough for the 64-byte callback_data budget. */
const TOKEN_LENGTH = 12;

const CANCELLED_MESSAGE = "Cancelled. Nothing was published.";
const NOT_YET = "Not available yet.";

export interface ApprovalEnv extends TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
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

  // A press from a superseded preview, or from one whose token was never
  // stored. Either way the message it came from is not describing this draft.
  if (draft.preview === null || !timingSafeEqual(parsed.token, draft.preview.token)) {
    await answerCallback(env, query.id, "This preview has been replaced. Use the newest one.");
    return;
  }

  if (draft.state !== "awaiting_approval") {
    await answerCallback(env, query.id, `Already ${draft.state.replace("_", " ")}.`);
    return;
  }

  if (parsed.action === "cancel") {
    await cancelDraft(env, draft);
    await answerCallback(env, query.id, "Cancelled.");
    return;
  }

  // Publish lands with the publication task, edit and regenerate with the edit
  // flows, media with the photo pipeline. The buttons stay live rather than
  // being stripped, because nothing has been acted on yet.
  await answerCallback(env, query.id, NOT_YET);
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
