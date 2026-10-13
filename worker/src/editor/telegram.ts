/**
 * Asking the bot for a link to the site's article editor.
 *
 * Telegram can carry a note, but not an article: rich formatting there needs
 * Premium, there are no fonts to choose, and a picture cannot sit between two
 * paragraphs. So for an article the bot hands out a link instead — to /admin/
 * on the site, with a key that opens it for four hours (editor/keys.ts).
 *
 * Two questions at most. New or update; and for an update, which article — the
 * same chooser every other "which activity?" flow uses, buttons for the newest
 * few or a link, slug or id typed by hand. The key for an update names that one
 * article and opens no other.
 */
import { ALL_CHUNKS, CHOICES, findByReference, findRecord, loadRecords } from "../content/recent";
import type { PublicRecord } from "../content/records";
import { clearPending, setPendingWriteTarget } from "../drafts/pending";
import {
  answerCallback,
  sendMessage,
  type InlineKeyboardMarkup,
  type TelegramApiEnv,
} from "../telegram/api";
import type { TelegramCallbackQuery } from "../telegram/types";
import { KEY_TTL_MS, mintKey, type EditorKeyKind } from "./keys";

export interface WriteEnv extends TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
  CONTENT_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

/** Telegram truncates a long button label itself; this keeps the list readable first. */
const LABEL_MAX = 40;

const ASK = "Write a new article on the site, or change one that is already there?";
const WHICH =
  "Which article should I open?\n\n" +
  "Send its link, its slug or its id — the link I sent when it was published works — or pick one below.";
const NOTHING_PUBLISHED = "Nothing has been published yet, so there is nothing to change. Start a new article instead.";
const UNAVAILABLE = "I could not read the published activities just now. Try again in a moment.";
const NOT_FOUND =
  "I could not find an activity with that id or link. Send the link the bot gave you when it was published, " +
  "or press one of the buttons above.";
const GONE = "I could not find that activity any more.";
const CANCELLED = "Cancelled. No link was made.";
const MINT_FAILED = "I could not make a link just now. Try again in a moment.";

/**
 * The callback_data namespace. `wr:p:{recordId}` is 21 bytes, well inside
 * Telegram's 64.
 */
const PREFIX = "wr:";
const NEW = `${PREFIX}n`;
const UPDATE = `${PREFIX}u`;
const PICK = `${PREFIX}p:`;
const DISMISS = `${PREFIX}x`;

export function isWriteCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith(PREFIX);
}

/** The editor's address on the site, carrying the key. */
export function editorUrl(siteBaseUrl: string, key: string): string {
  const url = new URL("admin/", siteBaseUrl.replace(/\/*$/, "/"));
  url.searchParams.set("key", key);
  return url.toString();
}

/** "18:22 UTC", which is when the link stops working. */
function clock(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

export function formatLink(kind: EditorKeyKind, url: string, expiresAt: string, title?: string): string {
  const hours = KEY_TTL_MS / 3_600_000;
  const what = kind === "create" ? "write a new article" : `change "${title ?? "the article"}"`;
  return (
    `Here is the link to ${what} on the site:\n\n${url}\n\n` +
    `It works for ${hours} hours, until ${clock(expiresAt)}` +
    (kind === "update" ? ", and only for this article." : ".") +
    " Anyone holding it can publish on your site until then, so keep it to yourself."
  );
}

/** Reached from the button and from `/write`. */
export async function promptForWrite(env: WriteEnv, chatId: number): Promise<void> {
  await sendMessage(env, chatId, ASK, {
    inline_keyboard: [
      [
        { text: "New article", callback_data: NEW },
        { text: "Update an article", callback_data: UPDATE },
      ],
      [{ text: "Cancel", callback_data: DISMISS }],
    ],
  });
}

function label(record: PublicRecord, newest: boolean): string {
  const title =
    record.title.length > LABEL_MAX ? `${record.title.slice(0, LABEL_MAX - 1).trimEnd()}…` : record.title;
  return newest ? `Latest — ${title}` : title;
}

/**
 * An update link for one article, sent straight away. What "Text" on the
 * edit-activity keyboard does for an article: its text has headings, fonts and
 * pictures that a Telegram message would flatten.
 */
export function sendEditorLink(env: WriteEnv, chatId: number, record: PublicRecord): Promise<void> {
  return sendKey(env, chatId, "update", record);
}

async function sendKey(env: WriteEnv, chatId: number, kind: EditorKeyKind, record: PublicRecord | null): Promise<void> {
  let minted: { key: string; expiresAt: string };
  try {
    minted = await mintKey(env, kind, chatId, record?.id ?? null);
  } catch {
    console.error("Could not store an editor key");
    await sendMessage(env, chatId, MINT_FAILED);
    return;
  }
  const url = editorUrl(env.SITE_BASE_URL, minted.key);
  await sendMessage(env, chatId, formatLink(kind, url, minted.expiresAt, record?.title), undefined, {
    noLinkPreview: true,
  });
}

async function chooseArticle(env: WriteEnv, chatId: number): Promise<void> {
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

  // Armed before asking, so the answer can simply be typed.
  await setPendingWriteTarget(env.PRIVATE_BUCKET, chatId);
  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      ...records
        .slice(0, CHOICES)
        .map((record, index) => [{ text: label(record, index === 0), callback_data: `${PICK}${record.id}` }]),
      [{ text: "Cancel", callback_data: DISMISS }],
    ],
  };
  await sendMessage(env, chatId, WHICH, keyboard);
}

/** The link, slug or id the author typed after being asked which article. */
export async function applyWriteTarget(env: WriteEnv, chatId: number, text: string): Promise<void> {
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
    await setPendingWriteTarget(env.PRIVATE_BUCKET, chatId);
    return;
  }

  await sendKey(env, chatId, "update", record);
}

/** One press on a `wr:` button. Always answers the query, so no button spins forever. */
export async function handleWriteCallback(query: TelegramCallbackQuery, env: WriteEnv): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id ?? null;

  if (chatId === null) {
    await answerCallback(env, query.id, "This message is too old to act on.");
    return;
  }

  if (data === DISMISS) {
    await answerCallback(env, query.id, "Cancelled.");
    await clearPending(env.PRIVATE_BUCKET, chatId);
    await sendMessage(env, chatId, CANCELLED);
    return;
  }

  // Answered before the R2 reads, which Telegram would otherwise outwait.
  await answerCallback(env, query.id);

  if (data === NEW) {
    await clearPending(env.PRIVATE_BUCKET, chatId);
    await sendKey(env, chatId, "create", null);
    return;
  }

  if (data === UPDATE) {
    await chooseArticle(env, chatId);
    return;
  }

  if (data.startsWith(PICK)) {
    await clearPending(env.PRIVATE_BUCKET, chatId);
    let record: PublicRecord | null;
    try {
      record = await findRecord(env, data.slice(PICK.length), ALL_CHUNKS);
    } catch {
      await sendMessage(env, chatId, UNAVAILABLE);
      return;
    }
    if (record === null) {
      await sendMessage(env, chatId, GONE);
      return;
    }
    await sendKey(env, chatId, "update", record);
  }
}
