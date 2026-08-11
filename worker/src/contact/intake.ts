/**
 * The contact form's endpoint: the only route on this Worker a stranger is
 * meant to reach.
 *
 * Everything else here is either authenticated (the Telegram webhook, the
 * signed callbacks) or a relay for the site's own analytics. This one accepts
 * text typed by anyone, so the order of what follows is the point: the cheapest
 * refusals first, the ones that cost an outbound request next, and only then
 * anything that writes an object or spends an Actions run.
 *
 * The Worker deliberately does not decide whether a message is worth reading.
 * It accepts, stores and hands off; the checking job answers back through
 * callbacks/contact-checked.ts, which is what actually reaches Telegram.
 */
import { dispatchContactCheck, newJobToken, type ContactDispatchEnv } from "../publishing/dispatch";
import { newSubmission, saveSubmission } from "./store";
import { claimSubmissionSlot } from "./throttle";
import { MAX_TOKEN_LENGTH, verifyTurnstile, type TurnstileEnv } from "./turnstile";

/** Mirrors the form's own limits (site/src/contact-form.ts). Both sides check; only this one counts. */
const LIMITS = {
  name: { min: 1, max: 100 },
  // The longest address RFC 5321 allows.
  email: { max: 254 },
  message: { min: 10, max: 2000 },
} as const;

/**
 * Comfortably past a full-length message plus a token, and far short of what it
 * would take to make reading the body itself the attack.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Pragmatic rather than RFC-complete: one @, something either side, a dot in the domain. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ContactIntakeEnv extends TurnstileEnv, ContactDispatchEnv {
  PRIVATE_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

interface Submitted {
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
}

function siteOrigin(env: ContactIntakeEnv): string | null {
  try {
    return new URL(env.SITE_BASE_URL).origin;
  } catch {
    return null;
  }
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
}

function answer(status: number, origin: string | null, body?: Record<string, string>): Response {
  const headers = origin === null ? new Headers() : corsHeaders(origin);
  // Fetch forbids a body on 204, including an empty string.
  if (status === 204) return new Response(null, { status, headers });

  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body ?? { status: "refused" }), { status, headers });
}

/**
 * Reads the four fields, or returns null.
 *
 * Every string is trimmed before it is measured, so a message of two thousand
 * spaces is the empty message it actually is.
 */
function parseSubmitted(raw: string): Submitted | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;

  const text = (key: string): string | null => (typeof body[key] === "string" ? body[key].trim() : null);

  const name = text("name");
  const email = text("email");
  const message = text("message");
  const turnstileToken = text("turnstileToken");

  if (name === null || email === null || message === null || turnstileToken === null) return null;

  if (name.length < LIMITS.name.min || name.length > LIMITS.name.max) return null;
  if (email.length > LIMITS.email.max || !EMAIL.test(email)) return null;
  if (message.length < LIMITS.message.min || message.length > LIMITS.message.max) return null;
  if (turnstileToken.length === 0 || turnstileToken.length > MAX_TOKEN_LENGTH) return null;

  return { name, email, message, turnstileToken };
}

export async function handleContactSubmission(request: Request, env: ContactIntakeEnv): Promise<Response> {
  const allowedOrigin = siteOrigin(env);
  const presentedOrigin = request.headers.get("Origin");

  // Without a site origin there is nothing to allow, and answering anyway would
  // make this a form anybody could put on their own page.
  if (allowedOrigin === null) return answer(503, null);
  if (presentedOrigin !== allowedOrigin) return answer(403, null);

  if (request.method === "OPTIONS") return answer(204, allowedOrigin);
  if (request.method !== "POST") return answer(405, allowedOrigin);

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return answer(413, allowedOrigin, { status: "refused", reason: "too-large" });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return answer(413, allowedOrigin, { status: "refused", reason: "too-large" });
  }

  const submitted = parseSubmitted(raw);
  if (submitted === null) return answer(400, allowedOrigin, { status: "refused", reason: "invalid" });

  const address = request.headers.get("CF-Connecting-IP");

  const challenge = await verifyTurnstile(env, submitted.turnstileToken, address);
  if (challenge === "failed") {
    return answer(403, allowedOrigin, { status: "refused", reason: "challenge" });
  }
  if (challenge !== "passed") {
    // Unconfigured or unreachable: ours to fix, and not something to tell a
    // visitor they failed. Both already logged one line inside verifyTurnstile.
    return answer(503, allowedOrigin, { status: "unavailable" });
  }

  // After the challenge rather than before it, deliberately. What the throttle
  // bounds is the expensive part — an object written and an Actions run spent —
  // and none of that happens without a solved challenge anyway. Claiming first
  // would have charged a slot to somebody whose token had merely expired, and
  // then answered their perfectly reasonable second attempt with "that is a lot
  // of messages at once".
  let claimed: boolean;
  try {
    claimed = await claimSubmissionSlot(env.PRIVATE_BUCKET, address);
  } catch {
    // Storage is about to be needed for the submission itself, so there is no
    // point pretending this one can go further.
    console.error("Could not claim a contact submission slot");
    return answer(503, allowedOrigin, { status: "unavailable" });
  }
  if (!claimed) return answer(429, allowedOrigin, { status: "refused", reason: "throttled" });

  const jobToken = newJobToken();
  const submission = newSubmission(
    { name: submitted.name, email: submitted.email, text: submitted.message },
    jobToken,
  );

  try {
    await saveSubmission(env.PRIVATE_BUCKET, submission);
  } catch {
    console.error("Could not store a contact submission");
    return answer(503, allowedOrigin, { status: "unavailable" });
  }

  // Stored first, dispatched second. A job that started before the object
  // existed would find nothing to read; a stored message nothing was dispatched
  // for is only an object that expires.
  const dispatched = await dispatchContactCheck(env, submission.submissionId, jobToken);
  if (!dispatched) {
    return answer(502, allowedOrigin, { status: "unavailable" });
  }

  // Accepted, not delivered. The check runs for a minute or two after this
  // answer, and nothing here knows how it ends.
  return answer(202, allowedOrigin, { status: "queued" });
}
