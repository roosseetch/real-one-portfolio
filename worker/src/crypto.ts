const encoder = new TextEncoder();

/**
 * Constant-time string comparison, for secrets and capability tokens.
 *
 * A timing attack against V8 string equality, across the public internet and
 * through Cloudflare's edge, is not a credible threat. It is six lines and it
 * compares secrets, which is cheaper than defending `===` on a secret later.
 * Hand-rolled because crypto.subtle.timingSafeEqual is a workerd extension the
 * tests could not run, and node:crypto would drag a polyfill in for one call.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  // Length is not the secret here — it is a configuration or format choice —
  // and unequal lengths can never match anyway.
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 as lowercase hex.
 *
 * Used to turn a visitor's address into a throttling key. Not a secret and not
 * reversible in any useful sense at that size, but it does mean the private
 * bucket never holds a list of who visited the contact page.
 */
export async function sha256Hex(message: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(message)));
}

/**
 * HMAC-SHA256 as lowercase hex.
 *
 * Used to authenticate the media callback: GitHub Actions signs
 * `timestamp.nonce.body` with a secret both sides hold, and nothing else about
 * the request is trusted until that matches.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
