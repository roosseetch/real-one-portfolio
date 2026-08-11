/**
 * Contact submissions in the private R2 bucket.
 *
 * Under its own `contact/` prefix rather than beside the drafts, for two
 * reasons: these are messages from strangers rather than the author's own work,
 * and the bucket's lifecycle rules are written per prefix — a message that has
 * been delivered to Telegram has no reason to outlive the job that checked it.
 *
 * Nothing here ever writes to a public bucket. What a visitor sends is read
 * exactly twice, by the checking job and by the callback that forwards it, and
 * then it expires.
 */
import { isValidId, randomId } from "../ids";
import { CONTACT_SCHEMA_VERSION, type ContactSubmission } from "./types";

export function submissionKey(submissionId: string): string {
  return `contact/${submissionId}/submission.json`;
}

export async function saveSubmission(bucket: R2Bucket, submission: ContactSubmission): Promise<void> {
  await bucket.put(submissionKey(submission.submissionId), JSON.stringify(submission), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Null covers both "no such submission" and "the stored object is not one we
 * can read", which mean the same thing to every caller: there is nothing to
 * forward.
 */
export async function loadSubmission(
  bucket: R2Bucket,
  submissionId: string,
): Promise<ContactSubmission | null> {
  if (!isValidId(submissionId)) return null;

  const object = await bucket.get(submissionKey(submissionId));
  if (object === null) return null;

  let parsed: unknown;
  try {
    parsed = await object.json();
  } catch {
    return null;
  }

  return parseSubmission(parsed);
}

/** Checks only the fields the callback routes on. Deliberately shallow past that, like the draft store. */
function parseSubmission(data: unknown): ContactSubmission | null {
  if (typeof data !== "object" || data === null) return null;

  const submission = data as ContactSubmission;
  if (typeof submission.submissionId !== "string" || typeof submission.state !== "string") return null;
  if (typeof submission.jobToken !== "string") return null;
  if (typeof submission.message !== "object" || submission.message === null) return null;
  if (typeof submission.message.text !== "string") return null;

  return submission;
}

export function newSubmission(
  message: ContactSubmission["message"],
  jobToken: string,
  now: Date = new Date(),
  analytics?: ContactSubmission["analytics"],
): ContactSubmission {
  return {
    schemaVersion: CONTACT_SCHEMA_VERSION,
    // Minted here rather than derived from the message: the id becomes an
    // object key and travels through a workflow input, and a content-derived
    // one would leak what it was derived from into the Actions UI.
    submissionId: randomId(),
    state: "checking",
    receivedAt: now.toISOString(),
    jobToken,
    message,
    // Omitted rather than stored null, so an object carries the ids or says
    // nothing about them — the same rule the optional message fields follow.
    ...(analytics === undefined ? {} : { analytics }),
    verdict: null,
  };
}
