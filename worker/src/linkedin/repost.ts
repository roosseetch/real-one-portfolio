/**
 * Reposting a published activity to LinkedIn (issue #4).
 *
 * Three steps, and the middle one is not optional: choose an activity, approve
 * the exact words, then post. Nothing else in this codebase makes something
 * public without the author having seen precisely what becomes public, and a
 * LinkedIn post is the least reversible thing here — it lands in other people's
 * feeds within seconds.
 *
 * The fourth path is the interesting one. A member access token lasts sixty
 * days and most apps get no refresh token, so "the credential has expired" is a
 * normal Tuesday rather than an incident. It is answered with a login link and a
 * remembered activity, so one tap finishes what the press started.
 */
import { readChunk } from "../content/chunks";
import { readManifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { isValidId } from "../ids";
import { answerCallback, sendMessage, type InlineKeyboardMarkup, type TelegramApiEnv } from "../telegram/api";
import type { TelegramCallbackQuery } from "../telegram/types";
import { composePost } from "./compose";
import { authorizeUrl, isConfigured, refreshAccessToken, type LinkedInOAuthEnv } from "./oauth";
import { publishPost } from "./post";
import { createState } from "./state";
import {
  canRefresh,
  isUsable,
  loadToken,
  saveToken,
  tokenFromGrant,
  type LinkedInToken,
} from "./tokens";

/** How many activities the chooser offers. Enough to find a recent one, few enough to read at a glance. */
const CHOICES = 5;

/**
 * How far back a remembered activity is looked for.
 *
 * A state lives fifteen minutes, so anything that has fallen more than three
 * chunks back in that time is not the post somebody is still waiting on.
 */
const LOOKUP_CHUNKS = 3;

/** Telegram truncates a long button label itself; this keeps the list readable first. */
const LABEL_MAX = 40;

const CHOOSE = "Which activity should go to LinkedIn?";
const NOT_CONFIGURED =
  "LinkedIn is not set up for this deployment, so there is nothing to repost to.";
const NOTHING_PUBLISHED = "Nothing has been published yet, so there is nothing to repost.";
const GONE = "I could not find that activity any more.";
const CANCELLED = "Nothing was posted to LinkedIn.";
const POST_FAILED =
  "LinkedIn would not take that post. The activity is still on the site — try again in a moment.";
const UNAVAILABLE = "I could not reach the published activities just now. Try again in a moment.";

export interface RepostEnv extends TelegramApiEnv, LinkedInOAuthEnv {
  PRIVATE_BUCKET: R2Bucket;
  CONTENT_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

/**
 * The callback_data namespace, kept apart from the draft preview's.
 *
 * `l:` is a prefix nothing else uses, which is what lets webhook.ts route a
 * press here without parsing it first. Two characters, because the budget is 64
 * bytes and a record id already spends sixteen.
 */
const PREFIX = "l:";
const PICK = `${PREFIX}p:`;
const GO = `${PREFIX}g:`;
const DISMISS = `${PREFIX}x`;

export function isRepostCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith(PREFIX);
}

/* ------------------------------------------------------------------ reading */

/**
 * Published records, newest first.
 *
 * Chunks are read from the newest backwards and only until `enough` records are
 * in hand: answering "what did I publish recently" does not need the archive,
 * and reading it would cost one more R2 call for every ten records ever
 * published. `maxChunks` is the ceiling for the case where `enough` is never
 * reached — a manifest whose newest chunks are all short.
 */
async function loadRecords(
  env: RepostEnv,
  enough: number,
  maxChunks: number,
): Promise<PublicRecord[]> {
  const loaded = await readManifest(env.CONTENT_BUCKET);
  if (loaded === null) return [];

  const entries = loaded.manifest.records;
  const collected: PublicRecord[] = [];

  for (let i = entries.length - 1; i >= 0 && entries.length - i <= maxChunks; i--) {
    // unshift, so the array stays in publication order: the position tiebreak
    // below depends on it, exactly as the site's feed does.
    collected.unshift(...(await readChunk(env.CONTENT_BUCKET, entries[i].id)));
    if (collected.length >= enough) break;
  }

  return sortNewestFirst(collected);
}

/**
 * Publication order, newest first.
 *
 * The same rule as site/src/activity.ts: `publishedAt`, never `eventDate` —
 * which is null whenever the author's note named no date, and would drop every
 * undated record to the bottom however recent it is. A record with no
 * `publishedAt` predates the field, which makes it older than every record that
 * has one; among themselves those keep the order the chunks store them in.
 */
export function sortNewestFirst(records: PublicRecord[]): PublicRecord[] {
  const ordered = records.map((record, position) => ({ record, position }));

  ordered.sort((a, b) => {
    const at = typeof a.record.publishedAt === "string" ? a.record.publishedAt : null;
    const bt = typeof b.record.publishedAt === "string" ? b.record.publishedAt : null;

    // ISO 8601 in UTC, so lexicographic order is chronological order.
    if (at !== null && bt !== null) {
      if (at !== bt) return at < bt ? 1 : -1;
    } else if (at !== bt) {
      return at === null ? 1 : -1;
    }

    return b.position - a.position;
  });

  return ordered.map((entry) => entry.record);
}

/**
 * The record a button names.
 *
 * Searched over more chunks than the chooser offers, because the press and the
 * post can be minutes apart: an activity picked before a login can have been
 * pushed out of the newest few by the time the login finishes.
 */
async function findRecord(env: RepostEnv, recordId: string): Promise<PublicRecord | null> {
  if (!isValidId(recordId)) return null;

  const records = await loadRecords(env, Number.POSITIVE_INFINITY, LOOKUP_CHUNKS);
  return records.find((record) => record.id === recordId) ?? null;
}

/* ------------------------------------------------------------------ prompting */

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

function confirmKeyboard(recordId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "Post to LinkedIn", callback_data: `${GO}${recordId}` }],
      [{ text: "Cancel", callback_data: DISMISS }],
    ],
  };
}

/**
 * Offers the newest few activities.
 *
 * The top one is labelled as the default, which is what the issue's "if not
 * specified" means here: there is no unspecified press, only a first button
 * that says what it is.
 */
export async function promptForActivity(env: RepostEnv, chatId: number): Promise<void> {
  if (!isConfigured(env)) {
    await sendMessage(env, chatId, NOT_CONFIGURED);
    return;
  }

  let records: PublicRecord[];
  try {
    // Two chunks at most: the newest holds up to ten records, but it can have
    // just rolled and hold one, and a chooser with one entry is not a choice.
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

/* ------------------------------------------------------------------ pressing */

/**
 * Handles one press on a repost button.
 *
 * Always answers the callback query, on every branch: Telegram spins the button
 * until something does, and a spinner that never stops reads as a broken bot.
 */
export async function handleRepostCallback(query: TelegramCallbackQuery, env: RepostEnv): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id ?? null;

  if (data === DISMISS) {
    await answerCallback(env, query.id, "Cancelled.");
    if (chatId !== null) await sendMessage(env, chatId, CANCELLED);
    return;
  }

  // No chat means no way to show a confirmation or report a result, and posting
  // into the void is not an improvement on doing nothing.
  if (chatId === null) {
    await answerCallback(env, query.id, "This message is too old to act on.");
    return;
  }

  if (!isConfigured(env)) {
    await answerCallback(env, query.id, "LinkedIn is not set up.");
    await sendMessage(env, chatId, NOT_CONFIGURED);
    return;
  }

  if (data.startsWith(PICK)) {
    await answerCallback(env, query.id);
    await confirmRepost(env, chatId, data.slice(PICK.length));
    return;
  }

  if (data.startsWith(GO)) {
    // Answered before the post runs. LinkedIn takes seconds, and Telegram gives
    // up on an unanswered callback long before that.
    await answerCallback(env, query.id, "Posting…");
    await repostRecord(env, chatId, data.slice(GO.length));
    return;
  }

  await answerCallback(env, query.id, "Not available yet.");
}

/** Shows exactly what would go to LinkedIn, and asks. */
async function confirmRepost(env: RepostEnv, chatId: number, recordId: string): Promise<void> {
  const record = await findRecord(env, recordId);
  if (record === null) {
    await sendMessage(env, chatId, GONE);
    return;
  }

  const post = composePost(env.SITE_BASE_URL, record);
  await sendMessage(
    env,
    chatId,
    `Post this to LinkedIn?\n\n${post.preview}`,
    confirmKeyboard(record.id),
  );
}

/* ------------------------------------------------------------------ posting */

export type RepostOutcome = "posted" | "gone" | "failed" | "needs-login";

/**
 * Posts one activity, dealing with whatever state the credential is in.
 *
 * The order is deliberate: a token close to expiry is refreshed before the post
 * rather than after it fails, so the common case costs one round trip and the
 * author is not told about a 401 that a refresh would have absorbed. A 401 that
 * arrives anyway gets exactly one refresh-and-retry — more would be guessing.
 */
export async function repostRecord(
  env: RepostEnv,
  chatId: number,
  recordId: string,
): Promise<RepostOutcome> {
  const record = await findRecord(env, recordId);
  if (record === null) {
    await sendMessage(env, chatId, GONE);
    return "gone";
  }

  let token = await loadToken(env.PRIVATE_BUCKET);

  if (token !== null && !isUsable(token)) {
    token = canRefresh(token) ? await refreshed(env, token) : null;
  }

  if (token === null) {
    await askForLogin(env, chatId, record.id, "expired");
    return "needs-login";
  }

  const post = composePost(env.SITE_BASE_URL, record);
  let result = await publishPost(token.accessToken, token.authorUrn, post);

  if (result.status === "unauthorized" && canRefresh(token)) {
    // LinkedIn disagreed with our arithmetic about the expiry — a token can also
    // be revoked from the member's own settings page. One refresh, one retry.
    const renewed = await refreshed(env, token);
    if (renewed !== null) {
      token = renewed;
      result = await publishPost(token.accessToken, token.authorUrn, post);
    }
  }

  if (result.status === "unauthorized") {
    await askForLogin(env, chatId, record.id, "rejected");
    return "needs-login";
  }

  if (result.status === "failed") {
    await sendMessage(env, chatId, POST_FAILED);
    return "failed";
  }

  await sendMessage(
    env,
    chatId,
    result.url === ""
      ? `Posted "${record.title}" to LinkedIn.`
      : `Posted "${record.title}" to LinkedIn. ${result.url}`,
  );
  return "posted";
}

/** Renews the stored token, or null if LinkedIn would not renew it. */
async function refreshed(env: RepostEnv, token: LinkedInToken): Promise<LinkedInToken | null> {
  if (token.refreshToken === null) return null;

  const granted = await refreshAccessToken(env, token.refreshToken);
  if (granted.status !== "granted") return null;

  const next = tokenFromGrant(granted.token, token.authorUrn, token);

  try {
    await saveToken(env.PRIVATE_BUCKET, next);
  } catch {
    // The new token works; only the bookkeeping failed. Using it for this post
    // is strictly better than refusing, and the next post refreshes again.
    console.error("Could not store the refreshed LinkedIn token");
  }

  return next;
}

/**
 * Sends the login link and remembers what it is for.
 *
 * The activity id rides along in the state, so finishing the login finishes the
 * post. Nothing new is approved by that: this is the record whose exact text the
 * author confirmed a moment ago.
 */
export async function askForLogin(
  env: RepostEnv,
  chatId: number,
  recordId: string | null,
  reason: "expired" | "rejected",
): Promise<void> {
  let state: string | null;
  try {
    state = await createState(env.PRIVATE_BUCKET, chatId, recordId);
  } catch (error) {
    console.error(`Could not store a LinkedIn login state: ${(error as Error).message}`);
    state = null;
  }

  if (state === null) {
    await sendMessage(env, chatId, "I could not start a LinkedIn login just now. Try again in a moment.");
    return;
  }

  const opening =
    reason === "rejected"
      ? "LinkedIn turned that down — the access token is no longer valid."
      : "The LinkedIn access token has expired.";

  const following =
    recordId === null
      ? "Log in again and the button will work."
      : "Log in again and I will post it for you:";

  await sendMessage(env, chatId, `${opening}\n\n${following}\n${authorizeUrl(env, state)}`);
}
