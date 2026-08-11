/**
 * What a contact-form submission is, between arriving from the site and
 * reaching Telegram.
 *
 * It exists as a stored object at all because the checking job runs outside
 * Cloudflare. Workflow inputs are visible in the Actions UI, so the message
 * itself cannot be passed to the job that way — it is written to the private
 * bucket, which the job reads with credentials that can only read.
 */

/**
 * 2 added the optional company and telephone fields. 3 added `analytics`, which
 * is how the verdict finds its way back to the visit that sent the message.
 * Readers stayed compatible with every earlier version rather than migrating:
 * each addition is optional, an object written before it simply has none, and
 * nothing stored here outlives the lifecycle rule on the `contact/` prefix by
 * more than a few days anyway.
 */
export const CONTACT_SCHEMA_VERSION = 3;

/**
 * `checking` is the only state a submission is created in, and the only one it
 * can be forwarded from. The callback decides which of the other two it
 * reaches, and both are terminal:
 *
 *   delivered  the check passed, or could not be run, and it reached Telegram
 *   discarded  the check called it spam or nonsense; nothing was sent
 *
 * A message Telegram refused is left in `checking` rather than given a state of
 * its own. It is still stored, so re-running the job delivers it — which is the
 * right answer to an outage, and one a terminal state would have taken away.
 */
export type ContactState = "checking" | "delivered" | "discarded";

/** What the checking job concluded. `undetermined` means the job could not reach a verdict. */
export type ContactVerdict = "deliver" | "discard" | "undetermined";

export interface ContactSubmission {
  schemaVersion: number;
  submissionId: string;
  state: ContactState;
  receivedAt: string;
  /** Proves a callback belongs to the job this submission was dispatched to. */
  jobToken: string;
  /**
   * Exactly what the visitor typed, unmodified. Only ever read back to be
   * checked and forwarded.
   *
   * `company` and `phone` are absent rather than empty when they were left
   * blank, which is the difference between "chose not to say" and "said
   * nothing", and saves every reader from testing for both.
   */
  message: {
    name: string;
    email: string;
    company?: string;
    phone?: string;
    text: string;
  };
  /**
   * The Amplitude device and session the message was sent from, when the page
   * had them.
   *
   * Kept only so the verdict — which arrives a minute or two later, on a
   * server-to-server callback with nothing of the visitor in it — can be
   * recorded against the visit that sent the message rather than against a
   * device the Worker invented. Absent for a deployment without analytics, and
   * for a browser that offered none.
   */
  analytics?: {
    deviceId: string;
    sessionId: number | null;
  };
  /** Filled in by the callback. Null while the job is still running. */
  verdict: {
    outcome: ContactVerdict;
    /** One short line from the checking job, shown to the author when a message is delivered. */
    reason: string;
    at: string;
  } | null;
}
