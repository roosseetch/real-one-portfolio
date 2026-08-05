/**
 * Crypto-random identifiers for drafts, activities, and record chunks.
 *
 * IDs must be non-sequential and content-independent: some of them end up in
 * public URLs, where a guessable scheme would let anyone enumerate content that
 * was never linked, and a content-derived one would leak what it was derived
 * from.
 */

/**
 * Crockford base32 — the digits and letters that survive being read aloud or
 * copied by hand, with i, l, o and u left out so they cannot be confused with
 * 1 and 0. Exactly 32 characters, so a random byte maps onto it without the
 * modulo bias a shorter alphabet would introduce.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 16 characters of a 32-character alphabet: 80 bits, far past any collision concern. */
const DEFAULT_LENGTH = 16;

export function randomId(length: number = DEFAULT_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}
