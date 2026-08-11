/**
 * One submission per address per minute.
 *
 * Turnstile already stands between the form and a script, but a solved
 * challenge is not free to us: every accepted submission mints an object and
 * dispatches a GitHub Actions run. Somebody willing to solve challenges could
 * otherwise turn the contact page into a way to spend this repository's Actions
 * minutes, which is a bill rather than a bug.
 *
 * The claim is a conditional write, exactly as the callback nonces are: R2
 * refuses to create an object that already exists, and refuses it atomically,
 * so two requests in the same second cannot both be the first.
 */
import { sha256Hex } from "../crypto";

const WINDOW_MS = 60 * 1000;

function slotKey(digest: string, window: number): string {
  // Under contact/, so the bucket's own rule on that prefix sweeps these up. A
  // slot is meaningless a minute after it was taken.
  return `contact/throttle/${digest.slice(0, 32)}-${window}.json`;
}

/**
 * True when this address had not submitted in the current minute, and has now.
 *
 * A missing address — no CF-Connecting-IP, which is what `wrangler dev` looks
 * like — is let through rather than refused. There is nothing to throttle on,
 * and refusing every local request would make the form untestable.
 */
export async function claimSubmissionSlot(
  bucket: R2Bucket,
  address: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  if (!address) return true;

  const digest = await sha256Hex(address);
  const window = Math.floor(now.getTime() / WINDOW_MS);

  const written = await bucket.put(slotKey(digest, window), JSON.stringify({ at: now.toISOString() }), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });

  return written !== null;
}
