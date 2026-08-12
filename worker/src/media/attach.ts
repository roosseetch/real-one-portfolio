/**
 * Adding photos or videos to an activity that is already on the site.
 *
 * The order is the author's, not the system's: the files first, the activity
 * second. Somebody with a picture in front of them is thinking "that belongs
 * with the run I posted", and asking which activity before they have found the
 * photo would mean holding the answer while they go looking.
 *
 * Everything between the files arriving and them becoming public is the
 * publishing path, unchanged — the same private originals, the same
 * sanitisation in a GitHub Actions runner, the same signed callback. What makes
 * this flow its own thing is only the two questions in the middle ("which
 * activity?" and "are you sure?") and the write at the end, which amends a
 * record instead of creating one.
 */
import { CHOICES, findByReference, findRecord, loadRecords } from "../content/recent";
import type { PublicRecord } from "../content/records";
import { cancelDraft, startMediaProcessing, type ApprovalEnv } from "../drafts/approval";
import { setPendingAttachTarget } from "../drafts/pending";
import { transition } from "../drafts/state";
import { loadDraft, saveDraft } from "../drafts/store";
import type { Draft } from "../drafts/types";
import { timingSafeEqual } from "../crypto";
import { randomId } from "../ids";
import {
  answerCallback,
  removeKeyboard,
  sendMessage,
  type InlineKeyboardMarkup,
  type TelegramApiEnv,
} from "../telegram/api";
import type { TelegramCallbackQuery } from "../telegram/types";

/** Matches every other keyboard here: unguessable inside the 64-byte callback_data budget. */
const TOKEN_LENGTH = 12;

/** Telegram truncates a long button label itself; this keeps the list readable first. */
const LABEL_MAX = 40;

const CHOOSE = "Which activity should these go on?";
const NOTHING_PUBLISHED =
  "Nothing has been published yet, so there is no activity to add media to. Send a note first and I will make one.";
const UNAVAILABLE = "I could not read the published activities just now. Try again in a moment.";
const GONE = "I could not find that activity any more.";
const NOT_FOUND =
  "I could not find an activity with that id or link. Send the link the bot gave you when it was published, " +
  "or press one of the buttons above.";
const ASK_FOR_REFERENCE =
  "Send the activity's link or id — the link I sent when it was published works, and so does the id on its own.";
const CANCELLED = "Cancelled. Nothing was added.";
const STALE = "This message has been replaced. Use the newest one.";

export interface AttachMediaEnv extends ApprovalEnv, TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
  CONTENT_BUCKET: R2Bucket;
}

/**
 * The callback_data namespace, kept apart from the draft preview's and the
 * repost flow's.
 *
 * `am:` is a prefix nothing else uses, which is what lets webhook.ts route a
 * press here without parsing it first — and, unlike a single letter, it cannot
 * collide with a preview action code that gains a meaning later.
 */
const PREFIX = "am:";
const PICK = `${PREFIX}p:`;
const OTHER = `${PREFIX}o:`;
const GO = `${PREFIX}g:`;
const DISMISS = `${PREFIX}x:`;

export function isAttachCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith(PREFIX);
}

/* ------------------------------------------------------------------ words */

/** "2 photos and a video", so the confirmation names what it is about to do. */
export function describeFiles(draft: Draft): string {
  const images = draft.originals.filter((original) => original.type === "image").length;
  const videos = draft.originals.length - images;

  const part = (count: number, one: string, many: string) =>
    count === 1 ? `1 ${one}` : `${count} ${many}`;

  const parts: string[] = [];
  if (images > 0) parts.push(part(images, "photo", "photos"));
  if (videos > 0) parts.push(part(videos, "video", "videos"));

  return parts.join(" and ");
}

function label(record: PublicRecord, newest: boolean): string {
  const title =
    record.title.length > LABEL_MAX ? `${record.title.slice(0, LABEL_MAX - 1).trimEnd()}…` : record.title;
  return newest ? `Latest — ${title}` : title;
}

/* ------------------------------------------------------------------ keyboards */

function chooserKeyboard(
  records: PublicRecord[],
  draftId: string,
  token: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...records.map((record, index) => [
        { text: label(record, index === 0), callback_data: `${PICK}${draftId}:${token}:${record.id}` },
      ]),
      [{ text: "Other — I'll send the link", callback_data: `${OTHER}${draftId}:${token}` }],
      [{ text: "Cancel", callback_data: `${DISMISS}${draftId}:${token}` }],
    ],
  };
}

function confirmKeyboard(draftId: string, token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "Add to this activity", callback_data: `${GO}${draftId}:${token}` }],
      [{ text: "Cancel", callback_data: `${DISMISS}${draftId}:${token}` }],
    ],
  };
}

/* ------------------------------------------------------------------ asking */

/**
 * Puts a keyboard on screen and records the token it carries.
 *
 * The same shape as `sendPreview`: a fresh token every time, so the buttons on
 * an older message stop working the moment a newer one replaces them, and the
 * message id so those buttons can be stripped once one is used. The draft moves
 * to `awaiting_approval` on the way, because from here on there is something to
 * approve — which is also what lets `startMediaProcessing` accept it later.
 */
async function ask(
  env: AttachMediaEnv,
  draft: Draft,
  text: string,
  keyboard: (draftId: string, token: string) => InlineKeyboardMarkup,
): Promise<Draft> {
  const token = randomId(TOKEN_LENGTH);
  const messageId = await sendMessage(env, draft.source.chatId, text, keyboard(draft.draftId, token));

  // Nothing is on screen, so nothing is awaiting an answer. The draft is left
  // where it was rather than moved into a state with no live button in it.
  if (messageId === null) {
    console.error("Could not ask the author which activity the media is for");
    return draft;
  }

  const moved = draft.state === "draft" ? transition(draft, "awaiting_approval") : draft;
  const next: Draft = { ...moved, preview: { messageId, token }, updatedAt: new Date().toISOString() };

  try {
    await saveDraft(env.PRIVATE_BUCKET, next);
  } catch {
    // The buttons are on screen carrying a token that was never stored, so they
    // will be refused as superseded rather than act on anything.
    console.error("Could not record the attachment token; its buttons will not work");
    return draft;
  }

  return next;
}

/**
 * Offers the newest few activities, once the files have been filed.
 *
 * Reached from the media intake in place of the preview an ordinary draft would
 * get: there is no entry to propose here, so there is nothing to show and only
 * this to ask.
 */
export async function promptForAttachTarget(env: AttachMediaEnv, draft: Draft): Promise<Draft> {
  if (draft.originals.length === 0) {
    // Every file was refused on the way in, and each refusal said so in its own
    // message. Asking which activity to add nothing to would be the third.
    await abandon(env, draft);
    return draft;
  }

  let records: PublicRecord[];
  try {
    // Two chunks at most, like the repost chooser: the newest holds up to ten
    // records, but it can have just rolled and hold one.
    records = await loadRecords(env, CHOICES, 2);
  } catch (error) {
    console.error(`Could not read published records: ${(error as Error).message}`);
    await sendMessage(env, draft.source.chatId, UNAVAILABLE);
    return draft;
  }

  if (records.length === 0) {
    await sendMessage(env, draft.source.chatId, NOTHING_PUBLISHED);
    await abandon(env, draft);
    return draft;
  }

  return ask(
    env,
    draft,
    `${describeFiles(draft)} received.\n\n${CHOOSE}`,
    (draftId, token) => chooserKeyboard(records.slice(0, CHOICES), draftId, token),
  );
}

/** Retires a draft nothing can be done with, quietly. */
async function abandon(env: AttachMediaEnv, draft: Draft): Promise<void> {
  try {
    await saveDraft(env.PRIVATE_BUCKET, { ...transition(draft, "cancelled"), preview: null });
  } catch {
    // It will expire with the bucket's seven-day rule either way. Nothing public
    // exists for it, so there is nothing to clean up.
    console.error("Could not retire an attachment draft with nothing to attach");
  }
}

/**
 * Names the target on the draft and asks the one question left.
 *
 * Shared by the button and the typed link, because the two differ only in how
 * the record was found. Nothing is dispatched here: the author sees which
 * activity they picked, spelled out, before any of it becomes public.
 */
async function confirm(env: AttachMediaEnv, draft: Draft, record: PublicRecord): Promise<Draft> {
  const targeted: Draft = {
    ...draft,
    attachment: { recordId: record.id },
    updatedAt: new Date().toISOString(),
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, targeted);
  } catch {
    console.error("Could not record which activity the media is for");
    await sendMessage(env, draft.source.chatId, UNAVAILABLE);
    return draft;
  }

  const already = (record.media ?? []).length;
  const has =
    already === 0
      ? "It has no media yet."
      : already === 1
        ? "It has 1 item already."
        : `It has ${already} items already.`;

  return ask(
    env,
    targeted,
    `Add ${describeFiles(draft)} to "${record.title}"?\n\n${has}`,
    confirmKeyboard,
  );
}

/**
 * Handles the activity link or id the author typed after pressing "Other".
 *
 * Returns false when the draft has moved on since — cancelled, or already
 * dispatched — which the intake turns back into an ordinary new note rather than
 * swallowing the message.
 */
export async function applyAttachTarget(
  env: AttachMediaEnv,
  draft: Draft,
  text: string,
): Promise<boolean> {
  if (draft.state !== "awaiting_approval" || (draft.attachment ?? null) === null) return false;

  let record: PublicRecord | null;
  try {
    record = await findByReference(env, text);
  } catch (error) {
    console.error(`Could not search published records: ${(error as Error).message}`);
    await sendMessage(env, draft.source.chatId, UNAVAILABLE);
    return true;
  }

  if (record === null) {
    // The pointer is spent by now, so the author is given the way back rather
    // than left to guess: another "Other" press, or the buttons still above.
    await sendMessage(env, draft.source.chatId, NOT_FOUND);
    await setPendingAttachTarget(env.PRIVATE_BUCKET, draft.source.chatId, draft.draftId);
    return true;
  }

  if (draft.preview !== null) {
    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
  }

  await confirm(env, draft, record);
  return true;
}

/* ------------------------------------------------------------------ pressing */

interface ParsedAttach {
  action: "pick" | "other" | "go" | "dismiss";
  draftId: string;
  token: string;
  recordId: string | null;
}

/** `am:<code>:<draftId>:<token>[:<recordId>]`, rejected wholesale if it is anything else. */
export function parseAttachCallback(data: string | undefined): ParsedAttach | null {
  if (!isAttachCallback(data)) return null;

  const parts = (data as string).split(":");
  // "am", code, draftId, token, and a record id on the pick.
  if (parts.length < 4 || parts.length > 5) return null;

  const [, code, draftId, token, recordId] = parts;
  if (draftId === "" || token === "") return null;

  const action =
    code === "p" ? "pick" : code === "o" ? "other" : code === "g" ? "go" : code === "x" ? "dismiss" : null;
  if (action === null) return null;
  if (action === "pick" && (recordId === undefined || recordId === "")) return null;
  if (action !== "pick" && recordId !== undefined) return null;

  return { action, draftId, token, recordId: recordId ?? null };
}

/**
 * Handles one press on an add-media button.
 *
 * Always answers the callback query, on every branch: Telegram spins the button
 * until something does, and a spinner that never stops reads as a broken bot.
 */
export async function handleAttachCallback(
  query: TelegramCallbackQuery,
  env: AttachMediaEnv,
): Promise<void> {
  const parsed = parseAttachCallback(query.data);
  if (parsed === null) {
    await answerCallback(env, query.id, "Not available yet.");
    return;
  }

  const draft = await loadDraft(env.PRIVATE_BUCKET, parsed.draftId);
  if (draft === null) {
    await answerCallback(env, query.id, "This is no longer available.");
    return;
  }

  // State before token, so a draft that has moved on says what actually
  // happened rather than sending the author looking for a newer message.
  if (draft.state !== "awaiting_approval" || (draft.attachment ?? null) === null) {
    await answerCallback(env, query.id, `Already ${draft.state.replace("_", " ")}.`);
    return;
  }

  if (draft.preview === null || !timingSafeEqual(parsed.token, draft.preview.token)) {
    await answerCallback(env, query.id, STALE);
    return;
  }

  if (parsed.action === "dismiss") {
    await answerCallback(env, query.id, "Cancelled.");
    await cancelDraft(env, draft, CANCELLED);
    return;
  }

  if (parsed.action === "other") {
    await answerCallback(env, query.id, "Send the link.");
    await setPendingAttachTarget(env.PRIVATE_BUCKET, draft.source.chatId, draft.draftId);
    await sendMessage(env, draft.source.chatId, ASK_FOR_REFERENCE);
    return;
  }

  if (parsed.action === "pick") {
    // Answered before the chunks are read: that is several R2 round trips, and
    // Telegram gives up on an unanswered callback long before them.
    await answerCallback(env, query.id);

    let record: PublicRecord | null;
    try {
      record = await findRecord(env, parsed.recordId as string);
    } catch (error) {
      console.error(`Could not read the chosen activity: ${(error as Error).message}`);
      await sendMessage(env, draft.source.chatId, UNAVAILABLE);
      return;
    }

    if (record === null) {
      await sendMessage(env, draft.source.chatId, GONE);
      return;
    }

    await removeKeyboard(env, draft.source.chatId, draft.preview.messageId);
    await confirm(env, draft, record);
    return;
  }

  // "Add to this activity": the point of no return, and the only branch that
  // starts work. The target has to have been chosen — a press on a chooser
  // keyboard cannot reach here, because that keyboard carries no `g` button.
  if ((draft.attachment?.recordId ?? null) === null) {
    await answerCallback(env, query.id, "Choose the activity first.");
    return;
  }

  await answerCallback(env, query.id, "Adding…");
  await startMediaProcessing(env, draft);
}
