/**
 * The authentication every callback from GitHub Actions passes (spec §13.3,
 * checks 1 to 4).
 *
 * Shared by both callbacks rather than copied into each. They are the only
 * routes outside Cloudflare that can change what the site shows or what the
 * author is told, and a check that drifts between them is a check that is not
 * there. What either one may then do with a verified body is its own business.
 */
import { hmacSha256Hex, timingSafeEqual } from "../crypto";
import { claimNonce } from "./nonces";

/**
 * How stale a signature may be. Long enough to survive a slow upload and clock
 * skew between GitHub and Cloudflare, short enough that a captured request is
 * useless by the time anyone could use it.
 */
const MAX_AGE_MS = 5 * 60 * 1000;

export interface SignedCallbackEnv {
  PRIVATE_BUCKET: R2Bucket;
  CALLBACK_HMAC_SECRET: string;
}

export type SignedCallback = { status: "verified"; raw: string } | { status: "refused" };

/** Terse and uniform. A caller that failed a check learns that it failed, not which one. */
export function refuse(status: number): Response {
  return new Response(status === 401 ? "Unauthorized" : "Bad request", { status });
}

/**
 * Returns the request body only once it has been proved to come from a job we
 * dispatched, and only the first time this exact request is seen.
 *
 * The order matters and is the spec's: the cheapest rejection first, the write
 * that spends a nonce last.
 */
export async function readSignedCallback(
  request: Request,
  env: SignedCallbackEnv,
): Promise<SignedCallback> {
  if (!env.CALLBACK_HMAC_SECRET) {
    // Fail closed, and say so once: an unconfigured secret means every callback
    // is refused, which is otherwise a mystifying 401.
    // Keep this visible to a live tail without allowing arbitrary callers to
    // create a durable error-log object for every request.
    console.warn("CALLBACK_HMAC_SECRET is not configured; refusing every callback");
    return { status: "refused" };
  }

  const timestamp = request.headers.get("X-Callback-Timestamp");
  const nonce = request.headers.get("X-Callback-Nonce");
  const signature = request.headers.get("X-Callback-Signature");
  if (!timestamp || !nonce || !signature) return { status: "refused" };

  // 1. Timestamp is recent. Checked before the signature so an ancient replay
  //    costs nothing to reject.
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_AGE_MS) {
    return { status: "refused" };
  }

  const raw = await request.text();

  // 2 and 3. Signature matches, compared in constant time.
  const expected = await hmacSha256Hex(env.CALLBACK_HMAC_SECRET, `${timestamp}.${nonce}.${raw}`);
  if (!timingSafeEqual(signature, expected)) return { status: "refused" };

  // 4. Nonce was not used. Only now, so an unauthenticated caller cannot burn
  //    nonces, and only once, because claiming is what spends it.
  if (!(await claimNonce(env.PRIVATE_BUCKET, nonce))) return { status: "refused" };

  return { status: "verified", raw };
}
