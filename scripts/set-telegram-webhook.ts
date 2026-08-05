/**
 * Points the Telegram bot at this deployment's Worker and confirms the result.
 *
 * The bot token and the shared secret are read from the environment, never
 * passed on the command line and never printed, so neither reaches shell
 * history or the terminal. The webhook path is a constant here rather than an
 * environment value: it has to match the Worker's router, and a hand-typed URL
 * with a typo registers happily and then 404s on every delivery.
 *
 * Registration succeeds even if the Worker is not deployed yet — Telegram does
 * not probe the URL — so the getWebhookInfo report at the end is the only place
 * a broken deployment shows up. Read last_error_message.
 *
 * Usage:
 *   set -a; . ./worker/.env; . ./worker/.dev.vars; set +a
 *   npm --prefix worker run webhook
 *
 * Exit code 0 = webhook registered, 1 = missing configuration or Telegram error.
 */

const API_BASE = "https://api.telegram.org";

/** Must match the route in worker/src/index.ts. */
const WEBHOOK_PATH = "/telegram/webhook";

/**
 * Least privilege, and exactly the update types the Worker's sender check can
 * read. Without this Telegram also delivers chat-member and channel updates,
 * which could only ever be ignored.
 */
const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"];

/** Telegram's documented charset for secret_token. */
const SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

interface TelegramResponse<T> {
  ok: boolean;
  description?: string;
  result?: T;
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_message?: string;
  last_error_date?: number;
}

function fail(heading: string, lines: string[], remedy?: string): never {
  console.error(heading);
  for (const line of lines) console.error(`  ${line}`);
  if (remedy) console.error(`\n${remedy}`);
  process.exit(1);
}

/**
 * Telegram reports failure two ways: a non-2xx status, and ok:false inside a
 * 200. Both have to be checked, or a rejected registration looks like a success.
 */
async function callBotApi<T>(token: string, method: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    // The URL would carry the bot token, so report only the reason.
    fail(`Could not reach the Telegram Bot API for ${method}:`, [(error as Error).message]);
  }

  let payload: TelegramResponse<T>;
  try {
    payload = (await response.json()) as TelegramResponse<T>;
  } catch {
    fail(`Telegram returned an unreadable response to ${method}:`, [`HTTP ${response.status}`]);
  }

  if (!response.ok || !payload.ok) {
    // `description` is Telegram's own error text and never contains the token.
    fail(`Telegram rejected ${method}:`, [payload.description ?? `HTTP ${response.status}`]);
  }

  return payload.result as T;
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const baseUrl = process.env.WORKER_BASE_URL;

const missing = Object.entries({
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_WEBHOOK_SECRET: secret,
  WORKER_BASE_URL: baseUrl,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  fail(
    "Cannot register the Telegram webhook. Missing values:",
    missing,
    "TELEGRAM_* live in worker/.dev.vars, WORKER_BASE_URL in worker/.env.\nSource both, then run again.",
  );
}

if (!SECRET_TOKEN_PATTERN.test(secret!)) {
  fail(
    "TELEGRAM_WEBHOOK_SECRET is not a shape Telegram accepts:",
    ["allowed characters are A-Z a-z 0-9 _ - , length 1-256"],
    // The usual footgun: a base64 secret contains + and =, and Telegram
    // refuses it with an error that does not say why.
    "`openssl rand -hex 32` produces a valid one.",
  );
}

let webhookUrl: string;
try {
  const parsed = new URL(`${baseUrl!.replace(/\/$/, "")}${WEBHOOK_PATH}`);
  if (parsed.protocol !== "https:") throw new Error("Telegram only delivers to https URLs");
  webhookUrl = parsed.toString();
} catch (error) {
  fail("WORKER_BASE_URL is not usable:", [(error as Error).message]);
}

await callBotApi(token!, "setWebhook", {
  url: webhookUrl,
  secret_token: secret,
  allowed_updates: ALLOWED_UPDATES,
  // Without this, re-registering after a secret rotation or a URL change
  // replays the whole queued backlog — one stale draft per message.
  drop_pending_updates: true,
});

const info = await callBotApi<WebhookInfo>(token!, "getWebhookInfo");

console.log(`Webhook registered for ${webhookUrl}`);
console.log(`  allowed updates: ${ALLOWED_UPDATES.join(", ")}`);
console.log(`  pending updates dropped`);
console.log(`  pending_update_count: ${info.pending_update_count ?? 0}`);
if (info.url !== webhookUrl) {
  console.error(`\nTelegram reports a different URL than the one just set: ${info.url || "(none)"}`);
  process.exit(1);
}
if (info.last_error_message) {
  console.log(`\nTelegram's last delivery attempt failed: ${info.last_error_message}`);
  console.log("Expected until the Worker is deployed and its custom domain is enabled.");
}
