/**
 * Outbound calls to the Telegram Bot API.
 *
 * Deliberately small: this exists so the author hears back when Workers AI
 * cannot finish (spec §23). The preview and its buttons build on it in a later
 * task.
 *
 * Nothing here throws. A failed reply must not turn a saved draft into a
 * webhook error, because that would have Telegram redeliver the message and
 * mint a second draft for the same thought.
 */

const API_BASE = "https://api.telegram.org";

export interface TelegramApiEnv {
  TELEGRAM_BOT_TOKEN: string;
}

export async function sendMessage(env: TelegramApiEnv, chatId: number, text: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!response.ok) {
      // Status only. The request URL carries the bot token and the body carries
      // the chat id, so neither belongs in a log.
      console.warn(`Telegram sendMessage failed with status ${response.status}`);
      return false;
    }

    return true;
  } catch {
    console.warn("Telegram sendMessage could not be delivered");
    return false;
  }
}
