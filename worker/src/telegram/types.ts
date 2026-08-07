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

/**
 * A file sent without Telegram's own image handling.
 *
 * Choosing "send as file" is how an author avoids Telegram re-compressing a
 * picture, and it is what Telegram does unprompted with .webp — so this is a
 * normal way to send media, not an edge case. Unlike `photo`, nothing here is
 * guaranteed to be an image, which is why `mime_type` has to be checked before
 * the file reaches the sanitiser.
 */
export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * A picture that Telegram decided was a sticker.
 *
 * Not the emoji-shop path it sounds like. Telegram converts a .webp upload into
 * a sticker on its own, so the same file an author meant to publish arrives
 * under a different field name depending on nothing they did — and a field
 * nothing reads is a message that gets answered "I could not find anything to
 * publish", which is untrue.
 *
 * `thumbnail` is deliberately absent, for the same reason the smallest `photo`
 * rendition is discarded: it is Telegram's downscale, and publishing it would
 * cap the resolution every derivative is generated from.
 */
export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  /** A .tgs, which is a gzipped vector animation and not a picture at all. */
  is_animated: boolean;
  /** A .webm loop. Still not a still. */
  is_video: boolean;
  width: number;
  height: number;
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
  /** An image or video sent as a file rather than through Telegram's compression. */
  document?: TelegramDocument;
  /** Where a .webp ends up when Telegram converts it on the way in. */
  sticker?: TelegramSticker;
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
