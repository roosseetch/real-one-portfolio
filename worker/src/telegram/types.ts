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

/**
 * One rendition of a photo. Telegram sends several sizes of the same image and
 * the largest is last, which is the only one worth keeping: the originals are
 * the input to sanitisation, so a thumbnail would throw away the resolution the
 * published derivatives are generated from.
 */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  // Optional because Telegram omits it on channel posts, which is exactly the
  // case the sender check has to reject rather than crash on.
  from?: TelegramUser;
  text?: string;
  /** Sizes of a single photo, smallest first. */
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  /** The text sent alongside media, which arrives here rather than in `text`. */
  caption?: string;
  /**
   * Present when the author sent several files at once. Telegram delivers an
   * album as one update per item, all carrying the same id, so this is the only
   * thing tying them together.
   */
  media_group_id?: string;
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
