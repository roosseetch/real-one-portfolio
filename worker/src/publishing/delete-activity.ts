/**
 * Deleting an activity that is already on the site.
 *
 * Removing a photo from an activity was the first thing here that destroyed
 * something; this is the larger version of it, and it is built the same way —
 * around making the author read what is about to go before it goes. The entry
 * itself, not one of its files, so the confirmation quotes the title and the
 * text rather than showing a thumbnail.
 *
 * The author names the activity, by pasted link, slug or id. That is the whole
 * reason the pointer is armed the moment the flow starts rather than behind an
 * "Other" button: the request was to be able to give the link of the thing to
 * delete, and the chooser above it is only a shortcut for a recent one.
 *
 * Any activity, not a recent one. Every other flow looks three chunks back —
 * thirty records — because a repost or an added photo is about something just
 * posted. A deletion that could not reach an entry from last year would be
 * useless, so this one reads the archive.
 */
import { ALL_CHUNKS, CHOICES, findByReference, findRecord, loadRecords } from "../content/recent";
import type { PublicRecord } from "../content/records";
import { activityUrl } from "../content/urls";
import { setPendingDeleteTarget, clearPending } from "../drafts/pending";
import { deletePublishedItem, locateMedia } from "../media/published";
import {
  answerCallback,
  sendMessage,
  MAX_MESSAGE,
  type InlineKeyboardMarkup,
  type TelegramApiEnv,
} from "../telegram/api";
import type { TelegramCallbackQuery } from "../telegram/types";
import { retractRecord } from "./amend";

/** Telegram truncates a long button label itself; this keeps the list readable first. */
const LABEL_MAX = 40;

const EMPTY = "—";

/** Said out loud, because a silent cut would break the one promise this message makes. */
const TRUNCATED = "\n[Text truncated. The whole entry is at the link below.]";

const ASK =
  "Which activity should I delete?\n\n" +
  "Send its link, its slug or its id — the link I sent when it was published works — or pick one below.";
const NOTHING_PUBLISHED = "Nothing has been published yet, so there is no activity to delete.";
const UNAVAILABLE = "I could not read the published activities just now. Try again in a moment.";
const GONE = "I could not find that activity any more.";
const NOT_FOUND =
  "I could not find an activity with that id or link. Send the link the bot gave you when it was published, " +
  "or press one of the buttons above.";
const CANCELLED = "Nothing was deleted.";
const DELETE_FAILED =
  "I could not delete that activity just now. It is still on the site — try again in a moment.";

/**
 * Said on the confirmation, in full, because every clause of it is a thing the
 * author cannot undo afterwards.
 */
const CONSEQUENCES =
  "Deleting takes the entry off the site for good, and its photos and videos are deleted with it. " +
  "Anything already posted to LinkedIn stays where it is, pointing at a page that will no longer exist.";

export interface DeleteActivityEnv extends TelegramApiEnv {
  CONTENT_BUCKET: R2Bucket;
  PRIVATE_BUCKET: R2Bucket;
  MEDIA_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

/**
 * The callback_data namespace, kept apart from every other one.
 *
 * `da:y:{recordId}` is 21 bytes, well inside Telegram's 64. No token rides
 * along, for the reason the remove-media buttons carry none: there is no draft
 * to hang one on, and every action names the exact record — so a stale press
 * deletes precisely the activity its own message quoted, or finds it already
 * gone and says so.
 */
const PREFIX = "da:";
const PICK = `${PREFIX}p:`;
const CONFIRM = `${PREFIX}y:`;
const DISMISS = `${PREFIX}x`;

export function isDeleteCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith(PREFIX);
}

/* ------------------------------------------------------------------ choosing */

function label(record: PublicRecord, newest: boolean): string {
  const title =
    record.title.length > LABEL_MAX ? `${record.title.slice(0, LABEL_MAX - 1).trimEnd()}…` : record.title;
  return newest ? `Latest — ${title}` : title;
}

function chooserKeyboard(records: PublicRecord[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...records.map((record, index) => [
        { text: label(record, index === 0), callback_data: `${PICK}${record.id}` },
      ]),
      [{ text: "Cancel", callback_data: DISMISS }],
    ],
  };
}

/**
 * Asks which activity to delete. Reached from the button and from
 * `/deleteactivity`.
 *
 * The pointer is armed before the question is asked, so the answer can simply be
 * typed. Nothing is armed when there is nothing to delete or the bucket cannot
 * be read — a pointer left behind in either case would swallow the author's next
 * note as a reference to an activity that was never offered.
 */
export async function promptForDeletion(env: DeleteActivityEnv, chatId: number): Promise<void> {
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

  await setPendingDeleteTarget(env.PRIVATE_BUCKET, chatId);
  await sendMessage(env, chatId, ASK, chooserKeyboard(records.slice(0, CHOICES)));
}

/* ------------------------------------------------------------------ showing */

/** "2 photos and a video", so the confirmation names everything that goes with the entry. */
function describeMedia(record: PublicRecord): string {
  const media = record.media ?? [];
  if (media.length === 0) return "No photos or videos.";

  const images = media.filter((item) => item.type === "image").length;
  const videos = media.length - images;

  const part = (count: number, one: string, many: string) =>
    count === 1 ? `1 ${one}` : `${count} ${many}`;

  const parts: string[] = [];
  if (images > 0) parts.push(part(images, "photo", "photos"));
  if (videos > 0) parts.push(part(videos, "video", "videos"));

  return `${parts.join(" and ")} ${media.length === 1 ? "goes" : "go"} with it.`;
}

/**
 * The question, with the entry quoted back.
 *
 * The title and the text, because those are what the author recognises an
 * activity by — an id names it uniquely and identifies it to nobody. The URL is
 * there too, so anything the message had to cut is one tap away while the
 * question is still unanswered.
 *
 * Only the text is ever cut, and the cut is announced. Everything after it — how
 * much media goes, the link, what cannot be undone — is what the author is being
 * asked to weigh, and a long body must not be what pushes it off the end.
 */
export function formatDeletionQuestion(record: PublicRecord, url: string): string {
  const body = record.body ?? record.summary;
  const text = body !== null && body.trim() !== "" ? body : EMPTY;

  // Absent on a record published before the field existed, and `slice` on
  // undefined throws — which would leave the author unable to delete precisely
  // the oldest entries this flow exists to reach.
  const published =
    typeof record.publishedAt === "string" ? [`Published ${record.publishedAt.slice(0, 10)}`] : [];

  const assemble = (shown: string) =>
    [
      "Delete this activity?",
      "",
      "Title",
      record.title,
      "",
      "Text",
      shown,
      "",
      ...published,
      describeMedia(record),
      url,
      "",
      CONSEQUENCES,
    ].join("\n");

  const whole = assemble(text);
  if (whole.length <= MAX_MESSAGE) return whole;

  const room = MAX_MESSAGE - assemble(TRUNCATED).length;
  const cut = assemble(`${text.slice(0, Math.max(room, 0))}${TRUNCATED}`);

  // A title long enough to overrun on its own is pathological rather than
  // impossible, and a message Telegram refuses would leave the author with no
  // question at all.
  return cut.length <= MAX_MESSAGE ? cut : cut.slice(0, MAX_MESSAGE);
}

function confirmKeyboard(recordId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "Yes, delete it", callback_data: `${CONFIRM}${recordId}` }],
      [{ text: "Keep it", callback_data: DISMISS }],
    ],
  };
}

async function show(env: DeleteActivityEnv, chatId: number, record: PublicRecord): Promise<void> {
  const url = activityUrl(env.SITE_BASE_URL, record);
  await sendMessage(env, chatId, formatDeletionQuestion(record, url), confirmKeyboard(record.id));
}

/* ------------------------------------------------------------------ pressing */

/** Handles the link, slug or id the author typed after being asked for one. */
export async function applyDeleteTarget(
  env: DeleteActivityEnv,
  chatId: number,
  text: string,
): Promise<void> {
  let record: PublicRecord | null;
  try {
    record = await findByReference(env, text, ALL_CHUNKS);
  } catch (error) {
    console.error(`Could not search published records: ${(error as Error).message}`);
    await sendMessage(env, chatId, UNAVAILABLE);
    return;
  }

  if (record === null) {
    // The pointer is spent by now, so it is armed again rather than leaving the
    // author's next attempt to be read as a new note.
    await sendMessage(env, chatId, NOT_FOUND);
    await setPendingDeleteTarget(env.PRIVATE_BUCKET, chatId);
    return;
  }

  await show(env, chatId, record);
}

/**
 * Handles one press on a delete-activity button.
 *
 * Always answers the callback query, on every branch: Telegram spins the button
 * until something does, and a spinner that never stops reads as a broken bot.
 */
export async function handleDeleteCallback(
  query: TelegramCallbackQuery,
  env: DeleteActivityEnv,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id ?? null;

  if (data === DISMISS) {
    await answerCallback(env, query.id, "Cancelled.");
    if (chatId !== null) {
      // The question is answered, so the promise that the next message names an
      // activity is spent with it.
      await clearPending(env.PRIVATE_BUCKET, chatId);
      await sendMessage(env, chatId, CANCELLED);
    }
    return;
  }

  // No chat means no way to show what would go or to report what did, and
  // deleting into the void is not an improvement on doing nothing.
  if (chatId === null) {
    await answerCallback(env, query.id, "This message is too old to act on.");
    return;
  }

  if (data.startsWith(PICK)) {
    // Answered before the chunks are read: that is several R2 round trips, and
    // Telegram gives up on an unanswered callback long before them.
    await answerCallback(env, query.id);
    await clearPending(env.PRIVATE_BUCKET, chatId);
    await open(env, chatId, data.slice(PICK.length));
    return;
  }

  if (data.startsWith(CONFIRM)) {
    await answerCallback(env, query.id, "Deleting…");
    await deleteActivity(env, chatId, data.slice(CONFIRM.length));
    return;
  }

  await answerCallback(env, query.id, "Not available yet.");
}

async function open(env: DeleteActivityEnv, chatId: number, recordId: string): Promise<void> {
  let record: PublicRecord | null;
  try {
    record = await findRecord(env, recordId, ALL_CHUNKS);
  } catch (error) {
    console.error(`Could not read the chosen activity: ${(error as Error).message}`);
    await sendMessage(env, chatId, UNAVAILABLE);
    return;
  }

  if (record === null) {
    await sendMessage(env, chatId, GONE);
    return;
  }

  await show(env, chatId, record);
}

/**
 * Takes the record off the site, then deletes the files it named.
 *
 * That order, and not the other one — the same rule the remove-media flow runs
 * on. While the record is still published the files it points at have to exist;
 * once it is gone they are unreferenced and can go. Reversing it would leave a
 * live page pointing at pictures that had already been deleted, which is a
 * broken activity rather than an incomplete cleanup.
 */
async function deleteActivity(
  env: DeleteActivityEnv,
  chatId: number,
  recordId: string,
): Promise<void> {
  const result = await retractRecord(env, recordId);

  if (result.status === "failed") {
    // "not-found" is the ordinary outcome of pressing a spent button, so it is
    // reported as the plain fact it is rather than as a failure.
    await sendMessage(env, chatId, result.reason === "not-found" ? GONE : DELETE_FAILED);
    return;
  }

  if (result.status !== "removed") {
    // Unreachable: the amendment returns null, so it can only remove. Reported
    // rather than assumed away, because the site is now in a state this function
    // did not intend.
    console.error(`Deleting an activity reported ${result.status}`);
    await sendMessage(env, chatId, DELETE_FAILED);
    return;
  }

  await deleteMedia(env, result.record);

  const left =
    result.remaining === 0
      ? "Nothing is published now."
      : result.remaining === 1
        ? "One activity is left."
        : `${result.remaining} activities are left.`;

  await sendMessage(env, chatId, `Deleted "${result.record.title}". ${left}`);
}

/**
 * Deletes the derivatives of every item the record named.
 *
 * Item by item rather than by emptying the activity's whole prefix: media added
 * after publication comes from its own draft and therefore its own prefix, so
 * one record's files can be spread across several — and a prefix wiped on the
 * assumption that it holds one activity's media would be the way to delete
 * another activity's by accident.
 *
 * A URL this cannot read is logged and left. It names no object under any prefix
 * of ours, so there is nothing here that could be deleted for it.
 */
async function deleteMedia(env: DeleteActivityEnv, record: PublicRecord): Promise<void> {
  for (const item of record.media ?? []) {
    const located = locateMedia(item.src);

    if (located === null) {
      console.error("Deleted an activity naming media this cannot locate; its files are left in place");
      continue;
    }

    const gone = await deletePublishedItem(env.MEDIA_BUCKET, located);
    if (gone === 0) {
      // The activity is off the site, which is what the author asked for, so
      // this is a line in the log rather than a worry in the chat.
      console.error("Deleted an activity but found none of one item's files to remove");
    }
  }
}
