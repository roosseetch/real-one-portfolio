/**
 * The gate in front of every Telegram update (spec §24: "verify webhook
 * secret", "restrict allowed Telegram user IDs").
 *
 * Two independent checks. The secret proves the request came from Telegram at
 * all; the allowlist proves it came from someone permitted to author content.
 * Nothing downstream — drafts, AI, publication — runs until both pass.
 */
import { timingSafeEqual } from "../crypto";
import { handlePreviewCallback, type ApprovalEnv } from "../drafts/approval";
import { intakeUpdate, type IntakeEnv } from "../drafts/intake";
import { handleRepostCallback, isRepostCallback, type RepostEnv } from "../linkedin/repost";
import { handleAttachCallback, isAttachCallback, type AttachMediaEnv } from "../media/attach";
import { handleDetachCallback, isDetachCallback, type DetachEnv } from "../media/detach";
import {
  handleDeleteCallback,
  isDeleteCallback,
  type DeleteActivityEnv,
} from "../publishing/delete-activity";
import type { TelegramUpdate } from "./types";

/** Telegram echoes the secret given to setWebhook back on every delivery. */
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/**
 * Only the two secrets this module reads, rather than the Worker's whole `Env`.
 * Importing `Env` from ../index would make a type-only import cycle that every
 * future module repeats, and this states the module's least privilege outright.
 */
export interface TelegramEnv {
  // Declared as possibly undefined because a secret that was never set arrives
  // that way at runtime, whatever the Env interface claims.
  TELEGRAM_WEBHOOK_SECRET: string | undefined;
  TELEGRAM_ALLOWED_USER_IDS: string | undefined;
}

/** What the route needs on top of the gate: somewhere to put the draft, and a way to reply. */
export interface WebhookEnv
  extends TelegramEnv,
    IntakeEnv,
    ApprovalEnv,
    RepostEnv,
    AttachMediaEnv,
    DetachEnv,
    DeleteActivityEnv {}

export type WebhookAuthorization =
  | { status: "authorized"; update: TelegramUpdate; senderId: number }
  | { status: "unauthenticated" }
  | { status: "ignored"; reason: "unparseable" | "no-sender" | "sender-not-allowed" };

/**
 * Reads the comma-separated allowlist into a set of user IDs.
 *
 * Malformed entries are skipped rather than thrown on: a bad entry can never
 * match anyone, so skipping is already fail-closed, while throwing would answer
 * a configuration mistake with a 500 and put Telegram into a retry loop. An
 * unset or empty list therefore denies everyone, which is the safe direction.
 */
export function parseAllowedUserIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    // Digits only. Number() would happily turn "1e3", "0x2a" or " 1.5 " into
    // something that either matches nobody or, worse, matches the wrong person.
    if (!/^\d+$/.test(trimmed)) continue;
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id)) continue;
    ids.add(id);
  }
  return ids;
}

/**
 * The user behind an update, across every type the webhook subscribes to.
 *
 * Null means the update carries no sender at all — a channel post, say — which
 * can never be authorized.
 */
export function senderId(update: TelegramUpdate): number | null {
  const from = update.message?.from ?? update.edited_message?.from ?? update.callback_query?.from;
  return typeof from?.id === "number" ? from.id : null;
}

/**
 * Deliberately shallow: an object with a numeric update_id is enough to route
 * on. Whoever later reads message.text or callback_query.data validates the
 * field it actually consumes, so this never has to grow into a copy of
 * Telegram's schema that the media tasks would need to edit.
 */
function parseUpdate(data: unknown): TelegramUpdate | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const update = data as TelegramUpdate;
  return typeof update.update_id === "number" ? update : null;
}

/**
 * Decides what to do with an incoming webhook request without acting on it.
 *
 * Returns a result rather than throwing so the three outcomes stay
 * exhaustively checkable, and so callers can act on the decision instead of
 * wrapping every future draft call in a try/catch.
 */
export async function authorizeWebhook(request: Request, env: TelegramEnv): Promise<WebhookAuthorization> {
  const configured = env.TELEGRAM_WEBHOOK_SECRET;
  if (!configured) {
    // Worth one line: it can only happen in a deployment where every delivery
    // fails anyway, and it turns an otherwise mystifying blanket 401 into a
    // one-line diagnosis.
    // A warning stays visible in `wrangler tail` without creating one durable
    // error-log object per unauthenticated request during a misconfiguration.
    console.warn("TELEGRAM_WEBHOOK_SECRET is not configured; rejecting every Telegram update");
    return { status: "unauthenticated" };
  }

  // Nothing is logged on a mismatch. Anyone who finds this URL could otherwise
  // drive unbounded log volume, and the operator already sees the 401 in
  // getWebhookInfo's last_error_message.
  const presented = request.headers.get(SECRET_HEADER);
  if (presented === null || !timingSafeEqual(presented, configured)) {
    return { status: "unauthenticated" };
  }

  // Past this point the caller knows the secret, so log volume is bounded.
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { status: "ignored", reason: "unparseable" };
  }

  const update = parseUpdate(payload);
  if (update === null) return { status: "ignored", reason: "unparseable" };

  const sender = senderId(update);
  if (sender === null) return { status: "ignored", reason: "no-sender" };

  const allowed = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowed.size === 0) {
    // This can be reached by every Telegram user while the deployment is
    // misconfigured, so it must not make each ignored update persist a log.
    console.warn("TELEGRAM_ALLOWED_USER_IDS is empty; no sender can author content");
  }
  if (!allowed.has(sender)) return { status: "ignored", reason: "sender-not-allowed" };

  return { status: "authorized", update, senderId: sender };
}

/**
 * Turns that decision into a response.
 *
 * The secret gate decides the status code; everything past it answers 200.
 * Telegram redelivers on any non-2xx with escalating backoff and eventually
 * throttles a failing webhook, so a decision already made must never be
 * re-litigated by retry. An unauthorized sender gets silence rather than a
 * refusal: no reply, no side effect, nothing that confirms the bot exists.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: WebhookEnv,
  /** Lets an album keep collecting after this response has gone back to Telegram. */
  ctx?: ExecutionContext,
): Promise<Response> {
  const authorization = await authorizeWebhook(request, env);

  if (authorization.status === "unauthenticated") {
    // No WWW-Authenticate header: there is no scheme worth advertising.
    return new Response("Unauthorized", { status: 401 });
  }

  if (authorization.status === "ignored") {
    // `reason` is a closed union of literals, so no part of the update — no
    // sender ID, no message text — can reach the log through it.
    console.warn(`Ignored a Telegram update: ${authorization.reason}`);
    return new Response(null, { status: 200 });
  }

  // A button press acts on a draft that already exists, so it never runs the
  // intake path — which would otherwise read the callback as a new message.
  const callbackQuery = authorization.update.callback_query;
  if (callbackQuery) {
    try {
      // Routed on the prefix rather than parsed first. The draft parser would
      // reject a repost button anyway, but it answers "Not available yet.",
      // which would be a lie about a button that works.
      if (isRepostCallback(callbackQuery.data)) {
        await handleRepostCallback(callbackQuery, env);
      } else if (isAttachCallback(callbackQuery.data)) {
        await handleAttachCallback(callbackQuery, env);
      } else if (isDetachCallback(callbackQuery.data)) {
        await handleDetachCallback(callbackQuery, env);
      } else if (isDeleteCallback(callbackQuery.data)) {
        await handleDeleteCallback(callbackQuery, env);
      } else {
        await handlePreviewCallback(callbackQuery, env);
      }
    } catch (error) {
      console.error(`Could not handle a button press: ${(error as Error).message}`);
      return new Response("Storage unavailable", { status: 503 });
    }
    return new Response(null, { status: 200 });
  }

  try {
    await intakeUpdate(authorization.update, authorization.senderId, env, (p) => ctx?.waitUntil(p));
  } catch (error) {
    // The one case where redelivery is worth having. Everything above this is a
    // decision that will not change on retry; a failed R2 write is a transient
    // fault, and letting Telegram send the message again is how it survives.
    console.error(`Could not store the draft: ${(error as Error).message}`);
    return new Response("Storage unavailable", { status: 503 });
  }

  // Task 16 hands the stored draft to Workers AI and Task 17 sends the preview
  // back. Until then the author gets no reply, only a draft in R2.
  return new Response(null, { status: 200 });
}
