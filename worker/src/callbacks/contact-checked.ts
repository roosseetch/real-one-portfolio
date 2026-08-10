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
import { timingSafeEqual } from "../crypto";
import { contactRecipient, formatContactMessage, type ContactRecipientEnv } from "../contact/message";
import { loadSubmission, saveSubmission } from "../contact/store";
import type { ContactState, ContactSubmission, ContactVerdict } from "../contact/types";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import { readSignedCallback, refuse, type SignedCallbackEnv } from "./signature";

export interface ContactCallbackEnv extends TelegramApiEnv, SignedCallbackEnv, ContactRecipientEnv {
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

export async function handleContactChecked(request: Request, env: ContactCallbackEnv): Promise<Response> {
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
    return settle(env, checked, "discarded");
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

  return settle(env, checked, "delivered");
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
  submission: ContactSubmission,
  state: ContactState,
): Promise<Response> {
  try {
    await saveSubmission(env.PRIVATE_BUCKET, { ...submission, state });
  } catch {
    console.error(`Could not record a contact submission as ${state}`);
    return new Response("Could not record the outcome", { status: 500 });
  }

  return Response.json({ status: state });
}
