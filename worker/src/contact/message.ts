/**
 * What a forwarded contact message looks like in Telegram.
 *
 * Plain text, like every other message this Worker sends: no parse_mode is set
 * anywhere, so an underscore or an angle bracket in a stranger's message cannot
 * mangle the message or fail the send.
 *
 * Who it goes to is decided here too, and deliberately not by a variable of its
 * own. The author is already identified to this Worker — she is the only person
 * allowed to write to it — and a second copy of her chat id would be one more
 * value to keep in step for no gain.
 */
import { parseAllowedUserIds } from "../telegram/webhook";
import type { ContactSubmission } from "./types";

/** Telegram refuses a message over 4096 characters; the fields are bounded well below that. */
const MAX_REASON_LENGTH = 200;

export interface ContactRecipientEnv {
  TELEGRAM_ALLOWED_USER_IDS: string | undefined;
}

/**
 * The chat a contact message is delivered to: the first id on the authoring
 * allowlist.
 *
 * Null means the allowlist is empty, which is the same misconfiguration that
 * stops anyone authoring at all — and it is better to keep the message stored
 * than to send it somewhere that was never chosen.
 */
export function contactRecipient(env: ContactRecipientEnv): number | null {
  const [first] = parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS);
  return first ?? null;
}

/**
 * One short line from the checking job, made safe to put in front of a person.
 *
 * The callback is signed, so this is not a trust boundary in the usual sense.
 * It is still a string a model wrote, arriving through a runner, so it is
 * clamped and stripped of the control characters that could rearrange the
 * message around it.
 */
function readableReason(reason: string): string {
  const cleaned = reason.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return "";
  return cleaned.length <= MAX_REASON_LENGTH ? cleaned : `${cleaned.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * The message itself.
 *
 * The visitor's own words are last and unmodified: everything above them is
 * this system talking, and a reply is written by reading what they wrote rather
 * than what the check made of it.
 */
export function formatContactMessage(submission: ContactSubmission): string {
  const { name, email, text } = submission.message;
  const verdict = submission.verdict;

  const lines = [
    "New message from the contact form.",
    "",
    `From: ${name} <${email}>`,
  ];

  if (verdict?.outcome === "undetermined") {
    // Said plainly rather than left out. A message that reached her without
    // being checked is one to read with more suspicion, not less, and silence
    // here would be indistinguishable from a check that passed.
    lines.push("The automatic check could not run, so this has not been screened.");
  } else {
    const reason = readableReason(verdict?.reason ?? "");
    if (reason !== "") lines.push(`Checked: ${reason}`);
  }

  lines.push("", text);
  return lines.join("\n");
}
