/**
 * Changing the wording of an activity that is already on the site.
 *
 * The third of the three things the author can do to something published, after
 * adding or removing its media and deleting it outright, and the one that
 * touches what a visitor actually reads. It is built the same way as the other
 * two — name the activity, be shown what is there, and answer one more question
 * before anything changes.
 *
 * No model. Every other route to a record's words runs them through Workers AI;
 * this one does not, and that is the whole design. An author fixing a typo in
 * something already public is not asking to be rewritten, and a model handed
 * "make it say Tuesday" can just as easily return a new second paragraph. What
 * the author types is what the record says, exactly as `/raw` promises on the
 * way in.
 *
 * One field at a time, chosen from a keyboard. The alternative — resending the
 * whole entry and diffing it — makes a one-word fix a retyping exercise and puts
 * every other field at risk of a paste that dropped one.
 */
import { ALL_CHUNKS, CHOICES, findByReference, findRecord, loadRecords } from "../content/recent";
import type { PublicRecord } from "../content/records";
import { activityUrl } from "../content/urls";
import { clearPending, setPendingEditField, setPendingEditTarget } from "../drafts/pending";
import {
  answerCallback,
  sendMessage,
  MAX_MESSAGE,
  type InlineKeyboardMarkup,
  type TelegramApiEnv,
} from "../telegram/api";
import type { TelegramCallbackQuery } from "../telegram/types";
import { amendRecord } from "./amend";
import {
  applyField,
  describeField,
  FIELD_LABELS,
  fieldCode,
  fieldFromCode,
  isClearable,
  parseFieldValue,
  type EditableField,
  type FieldValue,
} from "./edit-fields";
import { newEditId, saveProposedEdit, takeProposedEdit } from "./proposed-edit";

/** Telegram truncates a long button label itself; this keeps the list readable first. */
const LABEL_MAX = 40;

const ASK =
  "Which activity should I change?\n\n" +
  "Send its link, its slug or its id — the link I sent when it was published works — or pick one below.";
const NOTHING_PUBLISHED = "Nothing has been published yet, so there is nothing to change.";
const UNAVAILABLE = "I could not read the published activities just now. Try again in a moment.";
const GONE = "I could not find that activity any more.";
const NOT_FOUND =
  "I could not find an activity with that id or link. Send the link the bot gave you when it was published, " +
  "or press one of the buttons above.";
const CANCELLED = "Nothing was changed.";
const EXPIRED = "That change is no longer available. Start again and I will ask afresh.";
const SAVE_FAILED =
  "I could not change that activity just now. It still says what it said — try again in a moment.";
const UNCHANGED = "That is already what it says, so I have left it alone.";

export interface EditActivityEnv extends TelegramApiEnv {
  CONTENT_BUCKET: R2Bucket;
  PRIVATE_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

/**
 * The callback_data namespace, kept apart from every other one.
 *
 * `ea:f:{recordId}:{code}` is 23 bytes and `ea:y:{editId}` is 17, both well
 * inside Telegram's 64. Every action names exactly what it acts on, so a press
 * on a message that has been sitting in the chat for a while changes the field
 * that message was about — or finds its proposal spent and says so.
 */
const PREFIX = "ea:";
const PICK = `${PREFIX}p:`;
const FIELD = `${PREFIX}f:`;
const CLEAR = `${PREFIX}c:`;
const SAVE = `${PREFIX}y:`;
const DISMISS = `${PREFIX}x`;

export function isEditCallback(data: string | undefined): boolean {
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
 * Asks which activity to change. Reached from the button and from
 * `/editactivity`.
 *
 * The pointer is armed before the question is asked, so the answer can simply be
 * typed — the same shape the delete flow uses, and for the same reason: the link
 * the bot sent at publication is the thing nearest to hand.
 */
export async function promptForEdit(env: EditActivityEnv, chatId: number): Promise<void> {
  let records: PublicRecord[];
  try {
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

  await setPendingEditTarget(env.PRIVATE_BUCKET, chatId);
  await sendMessage(env, chatId, ASK, chooserKeyboard(records.slice(0, CHOICES)));
}

/* ------------------------------------------------------------------ the fields */

/**
 * Everything the record currently says, and a button per field.
 *
 * The whole entry rather than a list of field names: the author is choosing what
 * to change, and choosing it from what is actually there is the difference
 * between fixing the summary and fixing what they remember the summary saying.
 */
export function formatFields(record: PublicRecord, url: string): string {
  const lines = [`"${record.title}"`, "", "What should I change?", ""];

  for (const field of ["title", "summary", "body", "eventDate", "tags"] as EditableField[]) {
    lines.push(`${FIELD_LABELS[field]}: ${describeField(record, field)}`, "");
  }

  lines.push(url);

  const text = lines.join("\n");
  if (text.length <= MAX_MESSAGE) return text;

  const notice = "\n\n[Shortened. The whole entry is at the link below.]\n";
  return `${text.slice(0, MAX_MESSAGE - notice.length - url.length - 1)}${notice}${url}`;
}

function fieldKeyboard(recordId: string): InlineKeyboardMarkup {
  const button = (field: EditableField) => ({
    text: FIELD_LABELS[field],
    callback_data: `${FIELD}${recordId}:${fieldCode(field)}`,
  });

  return {
    inline_keyboard: [
      [button("title"), button("body")],
      [button("summary"), button("eventDate")],
      [button("tags")],
      [{ text: "Cancel", callback_data: DISMISS }],
    ],
  };
}

async function showFields(env: EditActivityEnv, chatId: number, record: PublicRecord): Promise<void> {
  const url = activityUrl(env.SITE_BASE_URL, record);
  await sendMessage(env, chatId, formatFields(record, url), fieldKeyboard(record.id));
}

/** What the author is asked once they have picked a field. */
export function formatFieldPrompt(record: PublicRecord, field: EditableField): string {
  const name = FIELD_LABELS[field].toLowerCase();
  const hint =
    field === "eventDate"
      ? "Send the new date as YYYY-MM-DD."
      : field === "tags"
        ? "Send the new tags, separated by commas. They replace the ones above."
        : `Send the new ${name}. It replaces what is there — nothing is rewritten and nothing is added.`;

  return `${FIELD_LABELS[field]} now reads:\n\n${describeField(record, field)}\n\n${hint}`;
}

function promptKeyboard(recordId: string, field: EditableField): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];

  // Offered rather than typed, because there is no sentence that unambiguously
  // means "empty" — an author sending a dash means a dash.
  if (isClearable(field)) {
    rows.push([
      { text: "Clear it", callback_data: `${CLEAR}${recordId}:${fieldCode(field)}` },
    ]);
  }

  rows.push([{ text: "Cancel", callback_data: DISMISS }]);
  return { inline_keyboard: rows };
}

/* ------------------------------------------------------------------ proposing */

/** The preview: the field as it would read, and the one press that makes it so. */
export function formatProposal(field: EditableField, value: FieldValue, title: string): string {
  const shown = Array.isArray(value)
    ? value.length === 0
      ? "—"
      : value.join(", ")
    : value === null || value.trim() === ""
      ? "—"
      : value;

  const text =
    `${FIELD_LABELS[field]} of "${title}" would become:\n\n${shown}\n\n` +
    "Nothing else about the activity changes.";

  if (text.length <= MAX_MESSAGE) return text;

  const notice = "\n\n[Shown shortened. The whole of it is what would be saved.]";
  return `${text.slice(0, MAX_MESSAGE - notice.length)}${notice}`;
}

/**
 * Files the typed value and shows it back.
 *
 * Nothing is written to the site here. The proposal waits in the private bucket
 * under an id the Save button carries, and is applied to whatever the record
 * says at the moment that button is pressed — so a photo added in between
 * survives the edit rather than being undone by it.
 */
async function propose(
  env: EditActivityEnv,
  chatId: number,
  record: PublicRecord,
  field: EditableField,
  value: FieldValue,
): Promise<void> {
  const editId = newEditId();

  try {
    await saveProposedEdit(env.PRIVATE_BUCKET, { editId, recordId: record.id, field, value });
  } catch {
    console.error("Could not store the proposed edit; nothing was changed");
    await sendMessage(env, chatId, SAVE_FAILED);
    return;
  }

  await sendMessage(env, chatId, formatProposal(field, value, record.title), {
    inline_keyboard: [
      [{ text: "Save it", callback_data: `${SAVE}${editId}` }],
      [{ text: "Cancel", callback_data: DISMISS }],
    ],
  });
}

/* ------------------------------------------------------------------ messages */

/** Handles the link, slug or id the author typed after being asked for one. */
export async function applyEditTarget(
  env: EditActivityEnv,
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
    await sendMessage(env, chatId, NOT_FOUND);
    await setPendingEditTarget(env.PRIVATE_BUCKET, chatId);
    return;
  }

  await showFields(env, chatId, record);
}

/**
 * Handles the new wording the author typed after picking a field.
 *
 * A rejected value re-arms the pointer rather than dropping back to nothing: the
 * author is mid-sentence about one field, and having their corrected attempt
 * become a brand-new activity would be the worst possible answer to "that title
 * is too long".
 */
export async function applyEditValue(
  env: EditActivityEnv,
  chatId: number,
  recordId: string,
  field: EditableField,
  text: string,
): Promise<void> {
  const parsed = parseFieldValue(field, text);

  if (parsed.status === "rejected") {
    await sendMessage(env, chatId, parsed.reason);
    await setPendingEditField(env.PRIVATE_BUCKET, chatId, recordId, field);
    return;
  }

  const record = await found(env, chatId, recordId);
  if (record === null) return;

  await propose(env, chatId, record, field, parsed.value);
}

/* ------------------------------------------------------------------ pressing */

/**
 * Handles one press on an edit-activity button.
 *
 * Always answers the callback query, on every branch: Telegram spins the button
 * until something does, and a spinner that never stops reads as a broken bot.
 */
export async function handleEditCallback(
  query: TelegramCallbackQuery,
  env: EditActivityEnv,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id ?? null;

  if (data === DISMISS) {
    await answerCallback(env, query.id, "Cancelled.");
    if (chatId !== null) {
      // Whatever the chat's next message was promised to, it is not this any
      // more.
      await clearPending(env.PRIVATE_BUCKET, chatId);
      await sendMessage(env, chatId, CANCELLED);
    }
    return;
  }

  if (chatId === null) {
    await answerCallback(env, query.id, "This message is too old to act on.");
    return;
  }

  if (data.startsWith(PICK)) {
    // Answered before the chunks are read: that is several R2 round trips, and
    // Telegram gives up on an unanswered callback long before them.
    await answerCallback(env, query.id);
    await clearPending(env.PRIVATE_BUCKET, chatId);

    const record = await found(env, chatId, data.slice(PICK.length));
    if (record !== null) await showFields(env, chatId, record);
    return;
  }

  if (data.startsWith(FIELD)) {
    await answerCallback(env, query.id);
    await openField(env, chatId, data.slice(FIELD.length));
    return;
  }

  if (data.startsWith(CLEAR)) {
    await answerCallback(env, query.id);
    await clearField(env, chatId, data.slice(CLEAR.length));
    return;
  }

  if (data.startsWith(SAVE)) {
    await answerCallback(env, query.id, "Saving…");
    await save(env, chatId, data.slice(SAVE.length));
    return;
  }

  await answerCallback(env, query.id, "Not available yet.");
}

/** `<recordId>:<fieldCode>`, rejected wholesale if it is anything else. */
function parseTarget(rest: string): { recordId: string; field: EditableField } | null {
  const parts = rest.split(":");
  if (parts.length !== 2) return null;

  const [recordId, code] = parts;
  const field = fieldFromCode(code);
  return recordId === "" || field === null ? null : { recordId, field };
}

/** Arms the chat for the new wording and says what the field says now. */
async function openField(env: EditActivityEnv, chatId: number, rest: string): Promise<void> {
  const target = parseTarget(rest);
  if (target === null) {
    await sendMessage(env, chatId, GONE);
    return;
  }

  const record = await found(env, chatId, target.recordId);
  if (record === null) return;

  await setPendingEditField(env.PRIVATE_BUCKET, chatId, target.recordId, target.field);
  await sendMessage(
    env,
    chatId,
    formatFieldPrompt(record, target.field),
    promptKeyboard(target.recordId, target.field),
  );
}

/** "Clear it": the same proposal path, with nothing in it. */
async function clearField(env: EditActivityEnv, chatId: number, rest: string): Promise<void> {
  const target = parseTarget(rest);
  if (target === null || !isClearable(target.field)) {
    await sendMessage(env, chatId, GONE);
    return;
  }

  const record = await found(env, chatId, target.recordId);
  if (record === null) return;

  // The chat was armed for a typed value and is no longer owed one.
  await clearPending(env.PRIVATE_BUCKET, chatId);
  await propose(env, chatId, record, target.field, target.field === "tags" ? [] : null);
}

/**
 * Applies the proposal to whatever the record says now.
 *
 * The value is put through `applyField` inside the amendment rather than before
 * it, which is what makes this safe against anything that landed since the
 * preview: the chunk is republished from the live record with one field
 * replaced, not from the copy the author was looking at.
 */
async function save(env: EditActivityEnv, chatId: number, editId: string): Promise<void> {
  const proposal = await takeProposedEdit(env.PRIVATE_BUCKET, editId);

  if (proposal === null) {
    await sendMessage(env, chatId, EXPIRED);
    return;
  }

  const result = await amendRecord(env, proposal.recordId, (record) =>
    applyField(record, proposal.field, proposal.value),
  );

  if (result.status === "failed") {
    await sendMessage(env, chatId, result.reason === "not-found" ? GONE : SAVE_FAILED);
    return;
  }

  if (result.status === "unchanged") {
    await sendMessage(env, chatId, UNCHANGED);
    return;
  }

  const url = activityUrl(env.SITE_BASE_URL, result.record);
  const name = FIELD_LABELS[proposal.field].toLowerCase();

  // The title is the slug, and the slug is the URL. An author who has just
  // renamed something needs to know the link they shared yesterday now names
  // nothing, and the one to use instead.
  const note =
    proposal.field === "title"
      ? "\nIts link changed with the title, so an older one no longer finds it."
      : "";

  await sendMessage(env, chatId, `Changed the ${name} of "${result.record.title}".\n${url}${note}`);
}

/** The record a button or a pointer names, or nothing plus the sentence that says so. */
async function found(
  env: EditActivityEnv,
  chatId: number,
  recordId: string,
): Promise<PublicRecord | null> {
  let record: PublicRecord | null;
  try {
    record = await findRecord(env, recordId, ALL_CHUNKS);
  } catch (error) {
    console.error(`Could not read the chosen activity: ${(error as Error).message}`);
    await sendMessage(env, chatId, UNAVAILABLE);
    return null;
  }

  if (record === null) await sendMessage(env, chatId, GONE);
  return record;
}
