/**
 * The authenticated callback GitHub Actions makes when a media job did not
 * finish (spec §23).
 *
 * Its counterpart in media-processed.ts is the only route that can put
 * something on the site. This one can only take a draft the author is already
 * waiting on and tell them it stopped, which is why it passes the same
 * authentication and the same job-token binding: without them, anyone who could
 * reach the Worker could interrupt a publication that was going fine.
 *
 * It publishes nothing, deletes nothing, and touches no public bucket. The most
 * it does is move one private draft from `processing` to `failed` and send one
 * message.
 */
import { failDraft, isFailureStage, type FailureEnv } from "../drafts/failure";
import { loadDraft } from "../drafts/store";
import { timingSafeEqual } from "../crypto";
import { readSignedCallback, refuse, type SignedCallbackEnv } from "./signature";

export interface FailureCallbackEnv extends SignedCallbackEnv, FailureEnv {}

interface FailureBody {
  draftId: string;
  jobId: string;
  stage: string;
}

function parseBody(raw: string): FailureBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as FailureBody;

  if (typeof body.draftId !== "string" || typeof body.jobId !== "string") return null;

  return body;
}

export async function handleMediaFailed(request: Request, env: FailureCallbackEnv): Promise<Response> {
  const signed = await readSignedCallback(request, env);
  if (signed.status !== "verified") return refuse(401);

  const body = parseBody(signed.raw);
  if (body === null) return refuse(400);

  const draft = await loadDraft(env.PRIVATE_BUCKET, body.draftId);
  if (draft === null) return refuse(400);

  // The job token, before anything is said about the draft's state. This is what
  // binds the report to the dispatch it belongs to: a run that was superseded by
  // a retry carries the old token and must not be able to fail the new attempt.
  if (draft.job === null || !timingSafeEqual(body.jobId, draft.job.jobToken)) return refuse(400);

  // A late failure for something that made it out anyway — the callback landed,
  // the record went live, and a later step of the same run then failed. Answered
  // rather than acted on: a published record is immutable and the author has
  // already been sent its link.
  if (draft.published !== null) {
    return Response.json({ status: "already-published", url: draft.published.url });
  }

  // Reported twice for the same job. The author has the buttons from the first
  // report; a second message would only offer them the same choice again.
  if (draft.state === "failed") {
    return Response.json({ status: "already-failed" });
  }

  // The media came back and is sitting in front of the author for a final look,
  // and something after that failed. Marking this failed would throw away a
  // confirmation that is live and correct.
  if (draft.state === "awaiting_approval" && (draft.processed ?? null) !== null) {
    return Response.json({ status: "awaiting-confirmation" });
  }

  if (draft.state !== "processing") return refuse(400);

  // Unrecognised stages become "unknown" rather than a refusal. A workflow that
  // grew a step this Worker has not heard of still has a draft stuck behind it,
  // and the author would rather hear a vaguer sentence than nothing at all.
  const stage = isFailureStage(body.stage) ? body.stage : "unknown";

  if (!(await failDraft(env, draft, stage))) {
    // The draft could not be written, so it is still `processing` and nothing
    // told the author. A non-200 is what makes the run's last step say so.
    return new Response("Could not record the failure", { status: 500 });
  }

  return Response.json({ status: "failed" });
}
