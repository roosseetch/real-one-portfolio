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
import {
  parseClientIdentity,
  trackServerEvents,
  type ClientIdentity,
  type DeferContext,
  type ServerAnalyticsEnv,
  type ServerEvent,
} from "../analytics/events";
import { dispatchContactCheck, newJobToken, type ContactDispatchEnv } from "../publishing/dispatch";
import { isValidId } from "../ids";
import { isVerified, normalizeEmail, recordMessage, redeemCode } from "./codes";
import { answer, guard } from "./cors";
import { newSubmission, saveSubmission } from "./store";
import { claimSubmissionSlot } from "./throttle";
import { MAX_TOKEN_LENGTH, verifyTurnstile, type TurnstileEnv } from "./turnstile";

/** Mirrors the form's own limits (site/src/contact-form.ts). Both sides check; only this one counts. */
const LIMITS = {
  name: { min: 1, max: 100 },
  // Well under RFC 5321's 254, which is deliberate: a shorter ceiling was asked
  // for, and an address longer than this is rare enough that refusing it costs
  // less than the field would.
  email: { min: 7, max: 64 },
  company: { min: 3, max: 64 },
  phone: { max: 24 },
  message: { min: 10, max: 300 },
} as const;

/** How many digits a phone number may hold. Fifteen is E.164's own ceiling. */
const PHONE_DIGITS = { min: 7, max: 15 } as const;

/**
 * Comfortably past a full-length message plus a token, and far short of what it
 * would take to make reading the body itself the attack.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Pragmatic rather than RFC-complete: one @, something either side, a dot in the domain. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A phone number by shape rather than by country: any of `+44 20 7946 0958`,
 * `(020) 7946 0958` or `020-7946-0958`, so long as the digits in it come to a
 * plausible count. Guessing at national formats would refuse real numbers, and
 * this field is optional — refusing a whole message over it would cost more
 * than it could save.
 */
function isValidPhone(value: string): boolean {
  if (value.length > LIMITS.phone.max) return false;
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;

  const digits = value.replace(/\D/g, "").length;
  return digits >= PHONE_DIGITS.min && digits <= PHONE_DIGITS.max;
}

export interface ContactIntakeEnv extends TurnstileEnv, ContactDispatchEnv, ServerAnalyticsEnv {
  PRIVATE_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

/**
 * What became of a submission, once the challenge had been passed. As in
 * verify.ts, nothing refused before the challenge is reported: those refusals
 * are what a bot's traffic looks like, and they are decided before anything has
 * established there is a person here at all.
 */
type Outcome = "accepted" | "throttled" | "unverified" | "storage-failed" | "dispatch-failed";

/** Which proof the browser offered, and how it went. */
type Proof = "code" | "token" | "none";
type Checked = "accepted" | "rejected" | "expired" | "stale" | "missing" | "storage-failed";

interface Submitted {
  name: string;
  email: string;
  /** Null for a field the visitor left blank, which both of these are allowed to be. */
  company: string | null;
  phone: string | null;
  message: string;
  turnstileToken: string;
  /** The six digits from the mail. Null when the browser is presenting a token instead. */
  code: string | null;
  /** The token a previous verification handed this browser, kept for thirty days. */
  verificationToken: string | null;
  /** The page's Amplitude device and session, when it has them. Never required. */
  identity: ClientIdentity | null;
}

/**
 * An optional field, in the three states it can arrive in: absent or blank
 * (null), present and usable (the trimmed string), or present and not a string
 * at all (false, which refuses the submission).
 *
 * A blank one is not an error. Somebody who tabs through a field and types a
 * space has left it empty, and telling them otherwise would be pedantry about a
 * field they were invited to skip.
 */
function optionalText(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Reads the fields, or returns null.
 *
 * Every string is trimmed before it is measured, so a message of three hundred
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

  const company = optionalText(body.company);
  const phone = optionalText(body.phone);
  if (company === false || phone === false) return null;

  if (name.length < LIMITS.name.min || name.length > LIMITS.name.max) return null;
  if (email.length < LIMITS.email.min || email.length > LIMITS.email.max || !EMAIL.test(email)) return null;
  if (company !== null && (company.length < LIMITS.company.min || company.length > LIMITS.company.max)) return null;
  if (phone !== null && !isValidPhone(phone)) return null;
  if (message.length < LIMITS.message.min || message.length > LIMITS.message.max) return null;
  if (turnstileToken.length === 0 || turnstileToken.length > MAX_TOKEN_LENGTH) return null;

  const code = optionalText(body.code);
  if (code === false) return null;
  // Six digits or nothing. A code of the wrong shape is refused here rather than
  // spending a read on the file to discover it cannot possibly match.
  if (code !== null && !/^\d{6}$/.test(code)) return null;

  const verificationToken = optionalText(body.verificationToken);
  if (verificationToken === false) return null;
  // The shape this Worker mints, and nothing else. A value of any other shape
  // could not match a stored token, so it is refused before a file is read.
  if (verificationToken !== null && !isValidId(verificationToken)) return null;

  return {
    name,
    email,
    company,
    phone,
    message,
    turnstileToken,
    code,
    verificationToken,
    identity: parseClientIdentity(body.analytics),
  };
}

export async function handleContactSubmission(
  request: Request,
  env: ContactIntakeEnv,
  ctx: DeferContext,
): Promise<Response> {
  // Origin, preflight and method, shared with /contact/verify so the two cannot
  // drift apart about who is allowed to talk to them.
  const allowedOrigin = guard(request, env);
  if (allowedOrigin instanceof Response) return allowedOrigin;

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

  /** What this press is offering as proof, whatever the proof turns out to be worth. */
  const proof: Proof = submitted.code !== null ? "code" : submitted.verificationToken !== null ? "token" : "none";

  /**
   * The address as the record files key it, so one person is one Amplitude user
   * however they typed it. Attached only to the events where the address has
   * actually been proved — an address somebody merely typed, or one whose code
   * was refused, is a claim rather than an identity.
   */
  const userId = normalizeEmail(submitted.email);

  let proven = false;
  const checks: ServerEvent[] = [];

  /** What the address check found. Nothing is recorded when it never ran. */
  const checked = (outcome: Checked): void => {
    checks.push({
      type: "contact_address_checked",
      ...(outcome === "accepted" ? { userId } : {}),
      properties: { proof, outcome },
    });
  };

  /**
   * Every answer from here down, reported as it is returned — one place rather
   * than one call beside each `return`, so a branch added later cannot become
   * the one outcome nothing ever recorded.
   *
   * Length and presence, never the words: what a stranger wrote to her is not
   * something to hand to a third party.
   */
  const finish = (status: number, body: Record<string, string>, outcome: Outcome): Response => {
    trackServerEvents(env, ctx, request, submitted.identity, [
      ...checks,
      {
        type: "contact_message_submitted",
        ...(proven ? { userId } : {}),
        properties: {
          proof,
          outcome,
          message_length: submitted.message.length,
          has_company: submitted.company !== null,
          has_phone: submitted.phone !== null,
        },
      },
    ]);
    return answer(status, allowedOrigin, body);
  };

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
    return finish(503, { status: "unavailable" }, "storage-failed");
  }
  if (!claimed) return finish(429, { status: "refused", reason: "throttled" }, "throttled");

  // Proof that whoever typed this address can read what is sent to it. Either
  // the code that was mailed a moment ago, or a verification recent enough that
  // no code was sent at all.
  //
  // After the throttle, because redeeming a code writes to the codes file and a
  // wrong guess is a write too — the cheap refusals have to come first, or
  // guessing would be free.
  // Two ways to prove the address, and the answer to both is the same word.
  //
  // A code, which is what somebody typing for the first time has, and which
  // mints a token on the way past; or that token, which is what a browser that
  // has done this before within the month presents instead. `issuedToken` is
  // non-null only in the first case, and is the one thing this endpoint tells
  // the browser that it did not already know.
  let issuedToken: string | null = null;
  try {
    if (submitted.code !== null) {
      const redeemed = await redeemCode(env.PRIVATE_BUCKET, submitted.email, submitted.code);
      proven = redeemed.outcome === "accepted";
      issuedToken = redeemed.token;
      // "rejected" is a code that did not match; "none" is an address holding no
      // live code at all. The visitor is told neither, but the difference between
      // a typo and a code that aged out is the whole of what a funnel wants here.
      checked(redeemed.outcome === "none" ? "expired" : redeemed.outcome);
    } else if (submitted.verificationToken !== null) {
      proven = await isVerified(env.PRIVATE_BUCKET, submitted.email, submitted.verificationToken);
      checked(proven ? "accepted" : "stale");
    } else {
      checked("missing");
    }
  } catch {
    console.error("Could not check a contact verification code");
    checked("storage-failed");
    return finish(503, { status: "unavailable" }, "storage-failed");
  }

  if (!proven) {
    // One answer for a wrong code, an expired one, a token that has been
    // retired, and an address that never asked for anything. Which of them it
    // was tells a guesser how close they are, and the form does the same thing
    // in every case: forget what it was holding and ask for a code. Which it was
    // is on contact_address_checked, where only she can read it.
    return finish(403, { status: "refused", reason: "unverified" }, "unverified");
  }

  const jobToken = newJobToken();
  const submission = newSubmission(
    {
      name: submitted.name,
      email: submitted.email,
      // Omitted rather than stored empty, so what is written down is what the
      // visitor actually chose to say.
      ...(submitted.company === null ? {} : { company: submitted.company }),
      ...(submitted.phone === null ? {} : { phone: submitted.phone }),
      text: submitted.message,
    },
    jobToken,
  );

  try {
    await saveSubmission(env.PRIVATE_BUCKET, submission);
  } catch {
    console.error("Could not store a contact submission");
    return finish(503, { status: "unavailable" }, "storage-failed");
  }

  // Stored first, dispatched second. A job that started before the object
  // existed would find nothing to read; a stored message nothing was dispatched
  // for is only an object that expires.
  const dispatched = await dispatchContactCheck(env, submission.submissionId, jobToken);
  if (!dispatched) {
    return finish(502, { status: "unavailable" }, "dispatch-failed");
  }

  // The permanent record, written only for a message that was actually accepted.
  // Its failure is not the visitor's problem: their message is stored and
  // dispatched, and telling them it failed would have them send it again.
  try {
    await recordMessage(env.PRIVATE_BUCKET, submission.message);
  } catch {
    console.error("Could not append to the contact message record");
  }

  // Accepted, not delivered. The check runs for a minute or two after this
  // answer, and nothing here knows how it ends.
  //
  // The token rides back only when a code was just redeemed. A browser that
  // already had one does not need it repeated, and an answer that always
  // carried it would hand a copy to anything that could make one accepted
  // request.
  return finish(
    202,
    issuedToken === null ? { status: "queued" } : { status: "queued", verificationToken: issuedToken },
    "accepted",
  );
}
