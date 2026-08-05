/**
 * The parts of the Telegram Bot API update payload this Worker reads.
 *
 * Deliberately partial. Every field declared here is a field something
 * validates before use; adding the rest of Telegram's schema would only create
 * types nobody checks. Later tasks extend these as they start reading more:
 * message entities for commands, photo and video for the media pipeline.
 */

export interface TelegramUser {
  id: number;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  // Optional because Telegram omits it on channel posts, which is exactly the
  // case the sender check has to reject rather than crash on.
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  // Always present: a button press comes from a user by definition.
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

/**
 * There is no `channel_post` here on purpose. A channel post carries no sender,
 * so it could never be authorized, and the webhook registration does not
 * subscribe to that update type in the first place.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
