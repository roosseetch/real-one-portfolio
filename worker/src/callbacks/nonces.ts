/**
 * Single-use nonces for the media callback (spec §13.3, check 4).
 *
 * A signature stays valid for as long as the timestamp window allows, so
 * without this a captured request could be replayed inside that window and
 * publish the same record again. The nonce is what makes each signed request
 * usable exactly once.
 *
 * Claiming is a conditional write: R2 refuses to create an object that already
 * exists, and refuses it atomically. Reading first and then writing would leave
 * a gap two concurrent replays could both pass through.
 */

/** Nonces are opaque to us, so the format is checked before one becomes a path. */
function isValidNonce(nonce: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(nonce);
}

function nonceKey(nonce: string): string {
  // Under drafts/ so the bucket's seven-day rule sweeps them up. A nonce
  // outlives its usefulness the moment its timestamp window closes, which is
  // minutes, so seven days is generous by a wide margin.
  return `drafts/callback-nonces/${nonce}.json`;
}

/**
 * True when this nonce had not been used before, and is now taken.
 *
 * False means it was already claimed — a replay, or a retry of a request that
 * already landed.
 */
export async function claimNonce(bucket: R2Bucket, nonce: string, now: Date = new Date()): Promise<boolean> {
  if (!isValidNonce(nonce)) return false;

  const written = await bucket.put(nonceKey(nonce), JSON.stringify({ claimedAt: now.toISOString() }), {
    // Fails rather than overwrites if the object exists. This is the whole
    // guarantee: R2 decides, atomically, which of two racing claims wins.
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });

  return written !== null;
}
