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
export const RAW_LABEL = "✍️ Publish as written";
export const REPOST_LABEL = "🔗 Repost to LinkedIn";
export const ADD_MEDIA_LABEL = "📎 Add media";
export const REMOVE_MEDIA_LABEL = "🗑 Remove media";
export const EDIT_ACTIVITY_LABEL = "✏️ Edit activity";
export const DELETE_ACTIVITY_LABEL = "❌ Delete activity";

/**
 * `is_persistent` keeps it open rather than collapsing to an icon after one
 * press; `resize_keyboard` stops Telegram reserving half the screen for two
 * rows. Deliberately not `one_time_keyboard`: the whole point is that it is
 * still there tomorrow.
 *
 * The first two rows make something; the next two act on something that already
 * exists and leave it existing; the last one destroys. Pairing them that way is
 * what keeps the keyboard glanceable at five rows rather than seven, and it puts
 * the two questions the author actually asks — "share this" and "fix this" —
 * beside each other.
 *
 * Deleting an activity has the last row to itself, and the row is the point. It
 * is the only button here that destroys an entry rather than a file, and sitting
 * it beside "Edit activity" — a thumb's width from a label that reads almost the
 * same — is precisely how the wrong one gets pressed.
 */
export const MAIN_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [
    [{ text: NEW_ACTIVITY_LABEL }],
    [{ text: RAW_LABEL }],
    [{ text: REPOST_LABEL }, { text: EDIT_ACTIVITY_LABEL }],
    [{ text: ADD_MEDIA_LABEL }, { text: REMOVE_MEDIA_LABEL }],
    [{ text: DELETE_ACTIVITY_LABEL }],
  ],
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
  if (trimmed === RAW_LABEL) return "raw";
  if (trimmed === REPOST_LABEL) return "repost";
  if (trimmed === ADD_MEDIA_LABEL) return "addmedia";
  if (trimmed === REMOVE_MEDIA_LABEL) return "removemedia";
  if (trimmed === EDIT_ACTIVITY_LABEL) return "editactivity";
  if (trimmed === DELETE_ACTIVITY_LABEL) return "deleteactivity";

  return parseCommand(trimmed);
}

/** Shown once when the keyboard is put up, and again whenever it is asked for. */
export const WELCOME =
  "Send me a note, a photo, or a video and I will write it up for the site.\n\n" +
  `Or use the buttons: "${NEW_ACTIVITY_LABEL}" starts one, "${RAW_LABEL}" publishes a note in your own ` +
  `words with nothing rewritten, and "${REPOST_LABEL}" shares something already published.\n\n` +
  `"${ADD_MEDIA_LABEL}" and "${REMOVE_MEDIA_LABEL}" change the photos and videos on an activity ` +
  `that is already on the site, "${EDIT_ACTIVITY_LABEL}" changes its wording, and ` +
  `"${DELETE_ACTIVITY_LABEL}" takes one off it for good.`;

/**
 * The prompt behind "Add media".
 *
 * It asks for the files first and the activity second, which is the order the
 * author is already in: they are looking at a photo and thinking "that belongs
 * with the run I posted". Asking which activity first would mean holding that
 * answer while they go and find the picture.
 */
export const ADD_MEDIA_PROMPT =
  "Send the photos or videos to add. You can send several at once.\n\n" +
  "I will ask which activity they belong to once they have arrived.";

/** The prompt behind the first button. The flow itself is just "send a message". */
export const NEW_ACTIVITY_PROMPT =
  "Go ahead — send the note, photo or video. I will come back with a draft to approve.";

/**
 * The prompt behind "Publish as written".
 *
 * It says where the title comes from, because that is the one thing the author
 * has to know to use this: everything else about the message is left alone, and
 * a heading has to come from somewhere.
 */
export const RAW_PROMPT =
  "Send the note and I will use it exactly as you write it — nothing rewritten, nothing added.\n\n" +
  "The first line becomes the title and the rest is the text. You still see it before anything is published.";
