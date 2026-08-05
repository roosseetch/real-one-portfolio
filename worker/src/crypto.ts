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
