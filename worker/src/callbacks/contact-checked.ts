/**
 * The authenticated callback the checking job makes once it has read a contact
 * submission and reached a verdict.
 *
 * Sibling of media-processed.ts, and authenticated exactly the same way: the
 * signature, the timestamp window and the single-use nonce all come from
 * signature.ts, so the two routes cannot drift apart on the part that matters.
 *
 * Nothing in the body decides what is sent. The verdict decides only whether
 * the stored message is forwarded; the message itself is read back out of the
 * private bucket, so a signed callback carrying different words could not put
 * them in front of her.
 */
import { trackServerEvents, type DeferContext, type ServerAnalyticsEnv } from "../analytics/events";
import { timingSafeEqual } from "../crypto";
import { normalizeEmail } from "../contact/codes";
import { contactRecipient, formatContactMessage, type ContactRecipientEnv } from "../contact/message";
import { loadSubmission, saveSubmission } from "../contact/store";
import type { ContactState, ContactSubmission, ContactVerdict } from "../contact/types";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import { readSignedCallback, refuse, type SignedCallbackEnv } from "./signature";

export interface ContactCallbackEnv
  extends TelegramApiEnv,
    SignedCallbackEnv,
    ContactRecipientEnv,
    ServerAnalyticsEnv {
  PRIVATE_BUCKET: R2Bucket;
}

interface CallbackBody {
  submissionId: string;
  jobId: string;
  verdict: ContactVerdict;
  reason: string;
  checkedAt: string;
}

const VERDICTS: ContactVerdict[] = ["deliver", "discard", "undetermined"];

function parseBody(raw: string): CallbackBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as CallbackBody;

  if (typeof body.submissionId !== "string" || typeof body.jobId !== "string") return null;
  if (!VERDICTS.includes(body.verdict)) return null;

  return { ...body, reason: typeof body.reason === "string" ? body.reason : "" };
}

export async function handleContactChecked(
  request: Request,
  env: ContactCallbackEnv,
  ctx: DeferContext,
): Promise<Response> {
  // Timestamp, signature and single-use nonce.
  const signed = await readSignedCallback(request, env);
  if (signed.status !== "verified") return refuse(401);

  const body = parseBody(signed.raw);
  if (body === null) return refuse(400);

  const submission = await loadSubmission(env.PRIVATE_BUCKET, body.submissionId);
  if (submission === null) return refuse(400);

  // Binds this callback to the dispatch that was made for this submission.
  // Ahead of the state check, so the repeat below cannot be forged.
  if (!timingSafeEqual(body.jobId, submission.jobToken)) return refuse(400);

  // A repeat of a callback that already landed — a re-run, or a retry of a
  // request whose answer was lost. Answered rather than refused: the job did
  // its work, and a 400 would fail a run that was right. This is also what
  // stops one submission being forwarded twice.
  if (submission.state !== "checking") {
    return Response.json({ status: submission.state });
  }

  const checked: ContactSubmission = {
    ...submission,
    verdict: {
      outcome: body.verdict,
      reason: body.reason,
      at: typeof body.checkedAt === "string" ? body.checkedAt : new Date().toISOString(),
    },
  };

  if (body.verdict === "discard") {
    // Nothing is sent and nothing is answered to whoever wrote it. The run's
    // own summary records that a message was discarded and why, which is where
    // to look if a real message ever goes missing.
    return settle(env, ctx, checked, "discarded");
  }

  const chatId = contactRecipient(env);
  if (chatId === null) {
    console.error("TELEGRAM_ALLOWED_USER_IDS is empty; a contact message has nowhere to go");
    // Left in `checking` deliberately: the message is still stored, and a
    // configuration fixed within the retention window can still be re-run.
    return new Response("No recipient configured", { status: 500 });
  }

  const messageId = await sendMessage(env, chatId, formatContactMessage(checked));
  if (messageId === null) {
    // Telegram refused or could not be reached. The submission stays in
    // `checking` and the run fails, which together are the only thing that
    // leaves a way back: re-running the job delivers the stored message. A
    // terminal state here would have quietly lost a message nobody ever saw.
    console.error("Could not deliver a contact message to Telegram");
    return new Response("Could not deliver the message", { status: 500 });
  }

  return settle(env, ctx, checked, "delivered");
}

/**
 * Records where the submission ended up and answers the job.
 *
 * The write is what makes a re-run idempotent, so a failure to persist is
 * reported as a failure: the job retrying is better than a second copy of the
 * same message arriving with nothing to stop it.
 */
async function settle(
  env: ContactCallbackEnv,
  ctx: DeferContext,
  submission: ContactSubmission,
  state: ContactState,
): Promise<Response> {
  try {
    await saveSubmission(env.PRIVATE_BUCKET, { ...submission, state });
  } catch {
    console.error(`Could not record a contact submission as ${state}`);
    return new Response("Could not record the outcome", { status: 500 });
  }

  // Only once the outcome is written down. An event for a state that failed to
  // persist would describe a submission the next re-run is about to settle
  // again, and count it twice.
  report(env, ctx, submission, state);
  return Response.json({ status: state });
}

/**
 * What the check concluded, against the visit that sent the message.
 *
 * This is the end of the funnel and the only place a discarded message appears
 * at all: it never reaches Telegram, so without this a spam message and a real
 * one are indistinguishable from the analytics side.
 *
 * The model's own reason is deliberately not sent. It is free text written by
 * something that has just read a stranger's message, so it is not ours to hand
 * to a third party — it stays in the run summary, where only she reads it.
 *
 * The address is named because it was proved at intake, and the device and
 * session come off the stored submission: this callback carries nothing of the
 * visitor, so without them the event would land on a device nobody ever used.
 * Nothing of the runner is sent either — its address and user agent are its
 * own, and passing them would move the visitor to a datacentre.
 */
function report(
  env: ContactCallbackEnv,
  ctx: DeferContext,
  submission: ContactSubmission,
  state: ContactState,
): void {
  trackServerEvents(env, ctx, null, submission.analytics ?? null, [
    {
      type: "contact_message_checked",
      userId: normalizeEmail(submission.message.email),
      properties: {
        outcome: state,
        verdict: submission.verdict?.outcome ?? "undetermined",
        message_length: submission.message.text.length,
      },
    },
  ]);
}
