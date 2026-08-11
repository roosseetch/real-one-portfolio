/**
 * `POST /contact/verify` — the endpoint that sends somebody a code.
 *
 * This is the only route on this Worker that makes it send mail to an address a
 * stranger chose, which makes it the one worth being careful with. Three things
 * stand in front of it, in ascending cost: the site's own origin, a Turnstile
 * challenge, and a per-address throttle. Without them it would be a service for
 * delivering unwanted mail to anybody, signed by this domain.
 *
 * It answers the same way for every address it accepts. Whether a given address
 * has written to her before is not a stranger's business, and it is not this
 * endpoint's answer to give: a browser that has verified before holds a token
 * and never asks here at all.
 */
import {
  parseClientIdentity,
  trackServerEvents,
  type ClientIdentity,
  type DeferContext,
  type ServerAnalyticsEnv,
} from "../analytics/events";
import { CODE_TTL_MS, issueCode } from "./codes";
import { answer, guard } from "./cors";
import { sendVerificationCode, type ContactEmailEnv } from "./email";
import { claimVerificationSlot } from "./throttle";
import { MAX_TOKEN_LENGTH, verifyTurnstile, type TurnstileEnv } from "./turnstile";

/** An address and a token, and nothing else, so the ceiling is small. */
const MAX_BODY_BYTES = 4 * 1024;

/** Kept in step with the intake's own rule (worker/src/contact/intake.ts). */
const EMAIL = { min: 7, max: 64, shape: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ } as const;

export interface ContactVerifyEnv extends TurnstileEnv, ContactEmailEnv, ServerAnalyticsEnv {
  PRIVATE_BUCKET: R2Bucket;
  SITE_BASE_URL: string;
}

/**
 * What became of a code request, once the challenge had been passed. Everything
 * refused before that reports nothing at all: a bad origin, an oversized body, a
 * malformed address and a failed challenge are the shapes a bot arrives in, and
 * none of them should be able to write into the analytics project for free.
 */
type Outcome = "sent" | "throttled" | "too-many-codes" | "mail-failed" | "storage-failed";

interface Requested {
  email: string;
  turnstileToken: string;
  /** The page's Amplitude device and session, when it has them. Never required. */
  identity: ClientIdentity | null;
}

function parseRequest(raw: string): Requested | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;

  const email = typeof body.email === "string" ? body.email.trim() : null;
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : null;
  if (email === null || turnstileToken === null) return null;

  if (email.length < EMAIL.min || email.length > EMAIL.max || !EMAIL.shape.test(email)) return null;
  if (turnstileToken.length === 0 || turnstileToken.length > MAX_TOKEN_LENGTH) return null;

  return { email, turnstileToken, identity: parseClientIdentity(body.analytics) };
}

export async function handleContactVerify(
  request: Request,
  env: ContactVerifyEnv,
  ctx: DeferContext,
): Promise<Response> {
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

  const requested = parseRequest(raw);
  if (requested === null) return answer(400, allowedOrigin, { status: "refused", reason: "invalid" });

  const address = request.headers.get("CF-Connecting-IP");

  const challenge = await verifyTurnstile(env, requested.turnstileToken, address);
  if (challenge === "failed") {
    return answer(403, allowedOrigin, { status: "refused", reason: "challenge" });
  }
  if (challenge !== "passed") {
    return answer(503, allowedOrigin, { status: "unavailable" });
  }

  /**
   * Every answer from here down, reported as it is returned.
   *
   * One place rather than one call beside each `return`: a branch added later
   * has to go through this, so it cannot quietly become the one outcome nothing
   * ever recorded.
   */
  const finish = (status: number, body: Record<string, string>, outcome: Outcome): Response => {
    trackServerEvents(env, ctx, request, requested.identity, [
      { type: "contact_code_requested", properties: { outcome } },
    ]);
    return answer(status, allowedOrigin, body);
  };

  // Before anything is sent, and before the address is even looked up: an
  // address that is already verified still costs a read, and the point of the
  // throttle is to bound what one visitor can make this endpoint do.
  let claimed: boolean;
  try {
    claimed = await claimVerificationSlot(env.PRIVATE_BUCKET, address);
  } catch {
    console.error("Could not claim a contact verification slot");
    return finish(503, { status: "unavailable" }, "storage-failed");
  }
  if (!claimed) return finish(429, { status: "refused", reason: "throttled" }, "throttled");

  try {
    // No shortcut for an address that verified before, deliberately.
    //
    // This endpoint used to answer "already verified" by looking the address up,
    // which meant anybody who knew an address somebody else had verified could
    // send as them for a month. Whether an address has written before is now the
    // browser's own business: it holds the token it was given, and presents that
    // to /contact instead of ever reaching here.
    const issued = await issueCode(env.PRIVATE_BUCKET, requested.email);
    if (issued.status === "too-many") {
      return finish(429, { status: "refused", reason: "too-many-codes" }, "too-many-codes");
    }

    const sent = await sendVerificationCode(
      env,
      requested.email,
      issued.code,
      Math.round(CODE_TTL_MS / 60_000),
    );
    if (sent !== "sent") {
      // The code stays in the file. It is unreachable — nobody was told it — and
      // it ages out on its own, which is cheaper than a delete that could fail
      // in turn and leave the caller waiting.
      return finish(503, { status: "unavailable" }, "mail-failed");
    }

    return finish(200, { status: "code-sent" }, "sent");
  } catch {
    console.error("Could not record a contact verification code");
    return finish(503, { status: "unavailable" }, "storage-failed");
  }
}
