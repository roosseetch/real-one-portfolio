/**
 * Outbound calls to the Telegram Bot API.
 *
 * Nothing here throws. A failed reply must not turn a saved draft into a
 * webhook error, because that would have Telegram redeliver the message and
 * mint a second draft for the same thought. Callers get a false or a null and
 * decide what that is worth.
 *
 * No call sets parse_mode. The preview's whole job is to show exactly what
 * becomes public, and Markdown or HTML would both render the text and let an
 * underscore or angle bracket in generated prose mangle the message or fail
 * the send outright.
 */

const API_BASE = "https://api.telegram.org";

export interface TelegramApiEnv {
  TELEGRAM_BOT_TOKEN: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface TelegramResult<T> {
  ok: boolean;
  description?: string;
  result?: T;
}

/**
 * One place where the token is put into a URL, so it is one place to check
 * that no log statement ever sees it.
 */
async function call<T>(env: TelegramApiEnv, method: string, body: unknown): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Method and status only. The URL carries the bot token and the body
      // carries the chat id and the draft text.
      console.warn(`Telegram ${method} failed with status ${response.status}`);
      return null;
    }

    const payload = (await response.json()) as TelegramResult<T>;
    if (!payload.ok) {
      console.warn(`Telegram ${method} was rejected`);
      return null;
    }

    return payload.result ?? null;
  } catch {
    console.warn(`Telegram ${method} could not be delivered`);
    return null;
  }
}

/** Returns the sent message's id, which the preview needs in order to disable its buttons later. */
export async function sendMessage(
  env: TelegramApiEnv,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<number | null> {
  const result = await call<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

  return result?.message_id ?? null;
}

/**
 * Strips the buttons off a message that has been acted on (spec §24, "disable
 * used buttons"). Passing no markup at all is what removes the keyboard.
 */
export async function removeKeyboard(
  env: TelegramApiEnv,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  const result = await call(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId });
  return result !== null;
}

/**
 * Telegram spins the button until this is called, so it runs on every callback
 * including the rejected ones. `text` surfaces as a toast in the client.
 */
export async function answerCallback(
  env: TelegramApiEnv,
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  const result = await call(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
  return result !== null;
}
