/**
 * The two standing buttons, and the commands that do the same two things
 * (issue #4).
 *
 * Until now the bot had exactly one way in — send it a message — and nothing in
 * the chat said so. These are the affordance.
 *
 * A reply keyboard rather than an inline one, because an inline keyboard lives
 * in a message and scrolls away with it, while this has to be there whenever the
 * author opens the chat. The cost is that pressing a button sends its label as
 * an ordinary message, indistinguishable from a note, which is why the labels
 * live here as constants and intake matches on these very strings.
 */
import type { ReplyKeyboardMarkup } from "./api";
import { parseCommand, type Command } from "./commands";

export const NEW_ACTIVITY_LABEL = "📝 New site activity";
export const REPOST_LABEL = "🔗 Repost to LinkedIn";

/**
 * `is_persistent` keeps it open rather than collapsing to an icon after one
 * press; `resize_keyboard` stops Telegram reserving half the screen for two
 * rows. Deliberately not `one_time_keyboard`: the whole point is that it is
 * still there tomorrow.
 */
export const MAIN_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: NEW_ACTIVITY_LABEL }], [{ text: REPOST_LABEL }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Send a note, a photo, or a video",
};

export type MenuAction = Command;

/**
 * What the author typed or pressed, if it was one of ours.
 *
 * A button and its command are the same action by design: the keyboard sends its
 * label, the "/" menu sends the command, and neither should behave differently
 * from the other. Null means an ordinary message, which is the overwhelmingly
 * common case and must stay untouched.
 */
export function menuAction(text: string): MenuAction | null {
  const trimmed = text.trim();

  if (trimmed === NEW_ACTIVITY_LABEL) return "new";
  if (trimmed === REPOST_LABEL) return "repost";

  return parseCommand(trimmed);
}

/** Shown once when the keyboard is put up, and again whenever it is asked for. */
export const WELCOME =
  "Send me a note, a photo, or a video and I will write it up for the site.\n\n" +
  `Or use the buttons: "${NEW_ACTIVITY_LABEL}" starts one, "${REPOST_LABEL}" shares something already published.`;

/** The prompt behind the first button. The flow itself is just "send a message". */
export const NEW_ACTIVITY_PROMPT =
  "Go ahead — send the note, photo or video. I will come back with a draft to approve.";
