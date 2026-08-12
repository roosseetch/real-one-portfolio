/**
 * The bot's slash commands, and the parser that recognises one.
 *
 * Deliberately import-free. scripts/set-telegram-webhook.ts registers this list
 * with `setMyCommands`, and that script is compiled by the repository's NodeNext
 * program while the Worker's own sources are resolved as a bundle — so anything
 * this module reached for would have to satisfy both. Keeping it standalone is
 * what lets one list be the truth for both the "/" menu and the code that
 * answers it, instead of two lists that drift the first time one changes.
 */

export const COMMANDS = [
  "start",
  "new",
  "raw",
  "repost",
  "addmedia",
  "removemedia",
  "deleteactivity",
] as const;

export type Command = (typeof COMMANDS)[number];

/** What Telegram shows beside each command in the "/" menu and the Menu button. */
export const BOT_COMMANDS: Array<{ command: Command; description: string }> = [
  { command: "start", description: "Show the buttons and what they do" },
  { command: "new", description: "Start a new site activity" },
  { command: "raw", description: "Publish a note exactly as you write it" },
  { command: "repost", description: "Repost an activity to LinkedIn" },
  { command: "addmedia", description: "Add photos or videos to a published activity" },
  { command: "removemedia", description: "Remove a photo or video from a published activity" },
  { command: "deleteactivity", description: "Delete a published activity from the site" },
];

/**
 * The command a message is, if it is one.
 *
 * Arguments are ignored and the `@botname` suffix Telegram appends in groups is
 * stripped, so `/repost@dina_bot later` is `/repost`. Null for an ordinary
 * message, which is the overwhelmingly common case and must stay untouched.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const word = trimmed.split(/\s+/)[0].split("@")[0].slice(1).toLowerCase();
  return (COMMANDS as readonly string[]).includes(word) ? (word as Command) : null;
}
