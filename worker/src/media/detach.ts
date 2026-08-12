/**
 * Taking a photo or a video off an activity that is already on the site.
 *
 * No draft, no pipeline, no runner: nothing is being created, so there is
 * nothing to sanitise and nothing to approve in the sense the publishing path
 * means. What there is instead is the one thing this system does not otherwise
 * do — destroy something — and so the flow is built around making the author
 * look at the right file before it goes.
 *
 * Each item is sent as its own message with its own button under it, rather than
 * as an album with a numbered list beside it. Telegram allows no buttons on an
 * album, and a list that says "3" while the pictures scroll past above it is
 * exactly how the wrong one gets deleted. One picture, one button, and then one
 * more question before anything happens.
 */
import { CHOICES, findByReference, findRecord, loadRecords } from "../content/recent";
import type { PublicMedia, PublicRecord } from "../content/records";
import { activityUrl } from "../content/urls";
import { amendRecord } from "../publishing/amend";
import { setPendingDetachTarget } from "../drafts/pending";
import {
  answerCallback,
  sendMessage,
  sendPhoto,
  type InlineKeyboardMarkup,
  type TelegramApiEnv,
} from "../telegram/api";
import type { TelegramCallbackQuery } from "../telegram/types";
import { deletePublishedItem, locateMedia } from "./published";

/** Telegram truncates a long button label itself; this keeps the list readable first. */
const LABEL_MAX = 40;

const CHOOSE = "Which activity should I take media off?";
const NOTHING_PUBLISHED = "Nothing has been published yet, so there is no media to remove.";
const UNAVAILABLE = "I could not read the published activities just now. Try again in a moment.";
const GONE = "I could not find that activity any more.";
const NOT_FOUND =
  "I could not find an activity with that id or link. Send the link the bot gave you when it was published, " +
  "or press one of the buttons above.";
const ASK_FOR_REFERENCE =
  "Send the activity's link or id — the link I sent when it was published works, and so does the id on its own.";
const NO_MEDIA = "That activity has no photos or videos on it.";
const CANCELLED = "Nothing was removed.";
const REMOVE_FAILED =
  "I could not change that activity just now. Nothing was removed — try again in a moment.";
const UNREADABLE_ITEM =
  "I cannot work out which files that item is made of, so I have left it alone rather than delete the wrong ones.";

export interface DetachEnv extends TelegramApiEnv {
  CONTENT_BUCKET: R2Bucket;
  PRIVATE_BUCKET: R2Bucket;
  MEDIA_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

/**
 * The callback_data namespace, kept apart from every other one.
 *
 * `rm:p:{recordId}` is 21 bytes and `rm:d:{recordId}:{mediaId}` is 38, both
 * well inside Telegram's 64. No token rides along, and deliberately: there is no
 * draft to hang one on, and every action here names the exact record and the
 * exact item — a stale press removes precisely what its own message showed, or
 * finds it already gone and says so.
 */
const PREFIX = "rm:";
const PICK = `${PREFIX}p:`;
const OTHER = `${PREFIX}o`;
const ASK = `${PREFIX}d:`;
const CONFIRM = `${PREFIX}y:`;
const DISMISS = `${PREFIX}x`;

export function isDetachCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith(PREFIX);
}

/* ------------------------------------------------------------------ choosing */

function label(record: PublicRecord, newest: boolean): string {
  const title =
    record.title.length > LABEL_MAX ? `${record.title.slice(0, LABEL_MAX - 1).trimEnd()}…` : record.title;
  const stem = newest ? `Latest — ${title}` : title;
  return record.media.length === 0 ? `${stem} (no media)` : stem;
}

function chooserKeyboard(records: PublicRecord[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...records.map((record, index) => [
        { text: label(record, index === 0), callback_data: `${PICK}${record.id}` },
      ]),
      [{ text: "Other — I'll send the link", callback_data: OTHER }],
      [{ text: "Cancel", callback_data: DISMISS }],
    ],
  };
}

/** Offers the newest few activities. Reached from the button and from `/removemedia`. */
export async function promptForRemoval(env: DetachEnv, chatId: number): Promise<void> {
  let records: PublicRecord[];
  try {
    // Two chunks at most, like every other chooser here: the newest holds up to
    // ten records, but it can have just rolled and hold one.
    records = await loadRecords(env, CHOICES, 2);
  } catch (error) {
    console.error(`Could not read published records: ${(error as Error).message}`);
    await sendMessage(env, chatId, UNAVAILABLE);
    return;
  }

  if (records.length === 0) {
    await sendMessage(env, chatId, NOTHING_PUBLISHED);
    return;
  }

  await sendMessage(env, chatId, CHOOSE, chooserKeyboard(records.slice(0, CHOICES)));
}

/* ------------------------------------------------------------------ showing */

/** What one item is called in the chat, given where it sits in the record. */
function caption(item: PublicMedia, index: number, total: number): string {
  const kind = item.type === "video" ? "Video" : "Photo";
  const described = item.caption ?? item.alt;
  const lines = [`${kind} ${index + 1} of ${total}`];
  if (described !== null && described.trim() !== "") lines.push(described);
  // The file itself, because the thumbnail below is a small derivative and the
  // author may need to open the full-size one to be sure which item this is.
  lines.push(item.src);
  return lines.join("\n");
}

/**
 * Sends every item of an activity, each with its own Remove button.
 *
 * The thumbnail is sent rather than the item: it is the narrowest derivative, so
 * Telegram fetches it quickly, and for a video it is the poster frame — sending
 * the clip itself would have Telegram refuse anything over 20 MB and leave a
 * gap where a picture should be. `src` is in every caption for exactly that
 * reason: whatever Telegram does with the thumbnail, the real file is one tap
 * away.
 */
async function showMedia(env: DetachEnv, chatId: number, record: PublicRecord): Promise<void> {
  const media = record.media ?? [];

  if (media.length === 0) {
    await sendMessage(env, chatId, NO_MEDIA);
    return;
  }

  await sendMessage(env, chatId, `"${record.title}" — pick what to remove:`);

  for (const [index, item] of media.entries()) {
    const located = locateMedia(item.src);
    const text = caption(item, index, media.length);

    // An item whose URL this cannot read is shown without a button rather than
    // hidden: the author should still see everything that is on the activity,
    // and a button that could not name the files to delete would be a lie.
    if (located === null) {
      await sendMessage(env, chatId, `${text}\n\n${UNREADABLE_ITEM}`);
      continue;
    }

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: "Remove this one", callback_data: `${ASK}${record.id}:${located.mediaId}` }],
      ],
    };

    const shown = await sendPhoto(env, chatId, item.thumbnail ?? item.poster ?? item.src, text, keyboard);

    // Telegram would not fetch the picture — too large, or momentarily
    // unavailable. The words and the button still have to arrive, or this item
    // is simply missing from a list the author is choosing from.
    if (shown === null) await sendMessage(env, chatId, text, keyboard);
  }

  await sendMessage(env, chatId, "Or press Cancel on any of them to leave it as it is.", {
    inline_keyboard: [[{ text: "Cancel", callback_data: DISMISS }]],
  });
}

/* ------------------------------------------------------------------ pressing */

/**
 * Handles the activity link or id the author typed after pressing "Other".
 *
 * Returns true when the message was consumed, which the intake needs in order to
 * decide whether it was a new note instead.
 */
export async function applyDetachTarget(env: DetachEnv, chatId: number, text: string): Promise<void> {
  let record: PublicRecord | null;
  try {
    record = await findByReference(env, text);
  } catch (error) {
    console.error(`Could not search published records: ${(error as Error).message}`);
    await sendMessage(env, chatId, UNAVAILABLE);
    return;
  }

  if (record === null) {
    // The pointer is spent by now, so it is armed again rather than leaving the
    // author's next attempt to be read as a new note.
    await sendMessage(env, chatId, NOT_FOUND);
    await setPendingDetachTarget(env.PRIVATE_BUCKET, chatId);
    return;
  }

  await showMedia(env, chatId, record);
}

/**
 * Handles one press on a remove-media button.
 *
 * Always answers the callback query, on every branch: Telegram spins the button
 * until something does, and a spinner that never stops reads as a broken bot.
 */
export async function handleDetachCallback(
  query: TelegramCallbackQuery,
  env: DetachEnv,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id ?? null;

  if (data === DISMISS) {
    await answerCallback(env, query.id, "Cancelled.");
    if (chatId !== null) await sendMessage(env, chatId, CANCELLED);
    return;
  }

  // No chat means no way to show what would go or to report what did, and
  // deleting into the void is not an improvement on doing nothing.
  if (chatId === null) {
    await answerCallback(env, query.id, "This message is too old to act on.");
    return;
  }

  if (data === OTHER) {
    await answerCallback(env, query.id, "Send the link.");
    await setPendingDetachTarget(env.PRIVATE_BUCKET, chatId);
    await sendMessage(env, chatId, ASK_FOR_REFERENCE);
    return;
  }

  if (data.startsWith(PICK)) {
    // Answered before the chunks are read: that is several R2 round trips, and
    // Telegram gives up on an unanswered callback long before them.
    await answerCallback(env, query.id);
    await open(env, chatId, data.slice(PICK.length));
    return;
  }

  if (data.startsWith(ASK)) {
    await answerCallback(env, query.id);
    await askToRemove(env, chatId, data.slice(ASK.length));
    return;
  }

  if (data.startsWith(CONFIRM)) {
    await answerCallback(env, query.id, "Removing…");
    await removeItem(env, chatId, data.slice(CONFIRM.length));
    return;
  }

  await answerCallback(env, query.id, "Not available yet.");
}

/** `<recordId>:<mediaId>`, rejected wholesale if it is anything else. */
function parseTarget(rest: string): { recordId: string; mediaId: string } | null {
  const parts = rest.split(":");
  if (parts.length !== 2) return null;
  const [recordId, mediaId] = parts;
  if (recordId === "" || mediaId === "") return null;
  return { recordId, mediaId };
}

async function open(env: DetachEnv, chatId: number, recordId: string): Promise<void> {
  const record = await found(env, chatId, recordId);
  if (record !== null) await showMedia(env, chatId, record);
}

/**
 * The second question, and the one that matters.
 *
 * The item is shown again with what is about to happen spelled out, because the
 * press that got here came from a message that may have been sitting in the chat
 * for a while — and because this is the only thing in the system that destroys
 * something a visitor can currently see.
 */
async function askToRemove(env: DetachEnv, chatId: number, rest: string): Promise<void> {
  const target = parseTarget(rest);
  if (target === null) {
    await sendMessage(env, chatId, GONE);
    return;
  }

  const record = await found(env, chatId, target.recordId);
  if (record === null) return;

  const position = (record.media ?? []).findIndex(
    (item) => locateMedia(item.src)?.mediaId === target.mediaId,
  );

  if (position === -1) {
    // Removed already, by an earlier press of this very button or another one.
    await sendMessage(env, chatId, "That item is not on the activity any more.");
    return;
  }

  const item = record.media[position];
  const kind = item.type === "video" ? "video" : "photo";

  await sendMessage(
    env,
    chatId,
    `Remove ${kind} ${position + 1} of ${record.media.length} from "${record.title}"?\n\n` +
      `${item.src}\n\nThe activity keeps everything else. The file itself is deleted and cannot be put back.`,
    {
      inline_keyboard: [
        [{ text: `Yes, remove this ${kind}`, callback_data: `${CONFIRM}${target.recordId}:${target.mediaId}` }],
        [{ text: "Keep it", callback_data: DISMISS }],
      ],
    },
  );
}

/**
 * Takes the item off the record, then deletes its files.
 *
 * That order, and not the other one. The record is what a visitor reads, so
 * while it still names the item the files have to exist; once it does not, they
 * are unreferenced and can go. Reversing it would leave a live page pointing at
 * a picture that had already been deleted, which is a broken activity rather
 * than an incomplete cleanup.
 */
async function removeItem(env: DetachEnv, chatId: number, rest: string): Promise<void> {
  const target = parseTarget(rest);
  if (target === null) {
    await sendMessage(env, chatId, GONE);
    return;
  }

  // Captured from the record rather than rebuilt from the ids, so the prefix
  // deleted below is the one the record actually pointed at.
  let removed: PublicMedia | null = null;

  const result = await amendRecord(env, target.recordId, (record) => {
    const media = record.media ?? [];
    const remaining = media.filter((item) => {
      const located = locateMedia(item.src);
      if (located?.mediaId !== target.mediaId) return true;
      removed = item;
      return false;
    });

    // Identity means "nothing to do", which is what makes a second press of an
    // already-spent button harmless rather than a pointless chunk rewrite.
    return remaining.length === media.length ? record : { ...record, media: remaining };
  });

  if (result.status === "failed") {
    await sendMessage(env, chatId, result.reason === "not-found" ? GONE : REMOVE_FAILED);
    return;
  }

  if (result.status === "unchanged") {
    await sendMessage(env, chatId, "That item is not on the activity any more.");
    return;
  }

  // Only now, and only for the item the record actually named. A location that
  // will not parse cannot reach here — `showMedia` draws no button for one — but
  // the delete is checked again on its own terms rather than on that assumption.
  const located = removed === null ? null : locateMedia((removed as PublicMedia).src);
  if (located !== null) {
    const gone = await deletePublishedItem(env.MEDIA_BUCKET, located);
    if (gone === 0) {
      // The activity no longer shows it, which is what the author asked for, so
      // this is a line in the log rather than a worry in the chat.
      console.error("Removed an item from a record but deleted none of its files");
    }
  }

  const url = activityUrl(env.SITE_BASE_URL, result.record);
  const left = result.record.media.length;
  const remaining =
    left === 0 ? "It has no media left." : left === 1 ? "One item is left." : `${left} items are left.`;

  await sendMessage(env, chatId, `Removed it from "${result.record.title}". ${remaining}\n${url}`);
}

/** The record a button names, or nothing plus the sentence that says so. */
async function found(env: DetachEnv, chatId: number, recordId: string): Promise<PublicRecord | null> {
  let record: PublicRecord | null;
  try {
    record = await findRecord(env, recordId);
  } catch (error) {
    console.error(`Could not read the chosen activity: ${(error as Error).message}`);
    await sendMessage(env, chatId, UNAVAILABLE);
    return null;
  }

  if (record === null) await sendMessage(env, chatId, GONE);
  return record;
}
