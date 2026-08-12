/**
 * The approval message (spec §7.2).
 *
 * It has one job: show exactly what would become public, so that approving it
 * is an informed act. Every field of the proposed record appears, in full —
 * the body is never summarised, and after a regeneration the whole preview is
 * re-sent rather than the changed field alone.
 */
import type { Draft, DraftRecord, ProcessedMedia } from "../drafts/types";
import { MAX_MESSAGE, type InlineKeyboardMarkup } from "./api";

/** Spec §7.2, quoted rather than paraphrased. */
const APPROVAL_QUESTION = "Is this the information and media that should become public?";

/** Spec Phase 6: the question asked when a transcode changed the clip visibly. */
const CONFIRMATION_QUESTION = "Publishing this version?";

const EMPTY = "—";

export const PREVIEW_ACTIONS = [
  "publish",
  "edit",
  "media",
  "regenerate",
  "retry",
  "generate",
  "verbatim",
  "cancel",
] as const;
export type PreviewAction = (typeof PREVIEW_ACTIONS)[number];

/**
 * Short codes keep callback_data inside Telegram's 64-byte limit alongside a
 * 16-character draft id and a 12-character token.
 *
 * Retry is `t` because `r` was already regenerate's, and generate is `g` for the
 * same reason: a code that changes meaning would give a button still sitting in
 * the chat a new one.
 */
export const ACTION_CODES: Record<string, PreviewAction> = {
  p: "publish",
  e: "edit",
  m: "media",
  r: "regenerate",
  t: "retry",
  g: "generate",
  v: "verbatim",
  c: "cancel",
};

const CODE_FOR: Record<PreviewAction, string> = {
  publish: "p",
  edit: "e",
  media: "m",
  regenerate: "r",
  retry: "t",
  generate: "g",
  verbatim: "v",
  cancel: "c",
};

const LABELS: Record<PreviewAction, string> = {
  publish: "Publish",
  edit: "Edit text",
  media: "Change media",
  regenerate: "Regenerate",
  retry: "Retry",
  generate: "Try again",
  verbatim: "Use my text",
  cancel: "Cancel",
};

function section(label: string, value: string | null): string {
  return `${label}\n${value && value.trim() !== "" ? value : EMPTY}`;
}

/**
 * What is said when a file was attached and none of it survived intake.
 *
 * The refusal itself was explained in its own message; this is on the preview
 * because the preview is what carries the Publish button, and approving one that
 * looks exactly like a note's is how a record went live describing a video it
 * does not contain. Publishing the words alone stays on offer — it just says so.
 */
const MEDIA_LOST =
  "None. What you attached did not come through, so publishing this posts the text on its own.";

export function formatPreview(record: DraftRecord, mediaDeclined = false): string {
  const body = [
    APPROVAL_QUESTION,
    "",
    section("Title", record.title),
    "",
    section("Date", record.eventDate),
    "",
    section("Summary", record.summary),
    "",
    section("Body", record.body),
    "",
    section("Tags", record.tags.length > 0 ? record.tags.join(", ") : null),
  ];

  if (mediaDeclined) {
    body.push("", section("Media", MEDIA_LOST));
  }

  // Media captions and alt text join here once there is media to describe.
  const text = body.join("\n");
  if (text.length <= MAX_MESSAGE) return text;

  // Truncating silently would break the one promise this message makes, so say
  // it happened. The full text is still what gets published.
  const notice = "\n\n[Preview truncated. The full text above is what will be published.]";
  return `${text.slice(0, MAX_MESSAGE - notice.length)}${notice}`;
}

/**
 * callback_data is `<code>:<draftId>:<token>` — about 30 bytes of the 64
 * Telegram allows. The draft id is already crypto-random and content
 * independent, so carrying it reveals nothing; the token is what makes a
 * button from a superseded preview stop working.
 */
function button(action: PreviewAction, draftId: string, token: string) {
  return { text: LABELS[action], callback_data: `${CODE_FOR[action]}:${draftId}:${token}` };
}

/**
 * "Use my text" sits beside Regenerate because the two answer the same
 * complaint from opposite ends: the model wrote the wrong thing, so either ask
 * it again or stop asking it. Cancel moves to its own row rather than sharing
 * one with an action that publishes different words — they were adjacent, and
 * adjacent is how the wrong one gets pressed.
 */
export function previewKeyboard(draftId: string, token: string): InlineKeyboardMarkup {
  const key = (action: PreviewAction) => button(action, draftId, token);

  return {
    inline_keyboard: [
      [key("publish")],
      [key("edit"), key("media")],
      [key("regenerate"), key("verbatim")],
      [key("cancel")],
    ],
  };
}

export function hasPreviewableRecord(draft: Draft): draft is Draft & { record: DraftRecord } {
  return draft.record !== null;
}

/**
 * The buttons under a processed video awaiting its final look.
 *
 * Publish and Cancel only. The text was approved on the first pass and the media
 * is now a finished file in the public bucket, so there is nothing left to edit
 * or regenerate — offering either would mean a button that can only be refused.
 * Same callback_data shape as above, so nothing about parsing a press changes.
 */
export function confirmationKeyboard(draftId: string, token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[button("publish", draftId, token)], [button("cancel", draftId, token)]],
  };
}

/**
 * The buttons under a failed publication (spec §23).
 *
 * Retry and Cancel, and nothing else: the text was approved before any of this
 * started, so editing or regenerating it now would answer a question nobody
 * asked. What went wrong was the publishing, and the only two useful replies to
 * that are "again" and "no".
 *
 * A fresh token per failure, like every other keyboard here, so the buttons under
 * an earlier failure of the same draft stop working once a retry has moved it on.
 */
export function failureKeyboard(draftId: string, token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[button("retry", draftId, token), button("cancel", draftId, token)]],
  };
}

/**
 * The buttons under a note the model could not describe.
 *
 * Distinct from `failureKeyboard` because the two failures are nothing alike.
 * That one follows an approval, and Retry runs the publication again; this one
 * comes before there is anything to approve, and the only work left to redo is
 * the generation. Sharing the `retry` code would have given a button on a
 * record-less draft the power to publish.
 *
 * Editing and regenerating are left off — there is no record yet, so either
 * would be a button that could only be refused. "Use my text" is the exception
 * and belongs here most of all: it needs nothing from the model, so it works
 * precisely when nothing else does.
 */
export function generationKeyboard(draftId: string, token: string): InlineKeyboardMarkup {
  const key = (action: PreviewAction) => button(action, draftId, token);

  return {
    inline_keyboard: [[key("generate"), key("verbatim")], [key("cancel")]],
  };
}

/**
 * What the author is asked when the transcode changed the clip visibly.
 *
 * Takes the clips that changed, already chosen by the caller — what counts as a
 * visible change is the sanitiser's judgement and the callback's filter, not a
 * formatting decision.
 *
 * The changes are named rather than summarised: "processed successfully" is not
 * something anyone can approve. Every clip's URL is in the text as well as being
 * sent as a video, because Telegram fetches a by-URL send itself and refuses
 * anything over 20 MB — a refused fetch must still leave something to tap.
 */
export function formatMediaConfirmation(changed: ProcessedMedia[]): string {
  const lines = [
    changed.length === 1
      ? "The video changed when it was processed:"
      : "The videos changed when they were processed:",
    "",
  ];

  for (const item of changed) {
    for (const change of item.visibleChanges) lines.push(`• ${change}`);
    lines.push(item.src, "");
  }

  lines.push(CONFIRMATION_QUESTION);

  const text = lines.join("\n");
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE - 1)}…`;
}
