/**
 * The single-use `state` that ties a LinkedIn redirect back to a request this
 * Worker made (spec §24's "verify webhook secret" rule, applied to the one other
 * route a browser reaches).
 *
 * /linkedin/callback is open to the internet by necessity — LinkedIn redirects a
 * browser to it — so the state is the whole guard. It is minted here, handed out
 * only inside a Telegram chat an allowlisted sender reached, and spent on first
 * use. Without a live one the callback does nothing at all.
 *
 * It also carries what the redirect cannot: which chat to answer, and which
 * activity was waiting to be posted when the token expired.
 *
 * Stored under `drafts/` so the bucket's seven-day rule sweeps up the ones
 * belonging to logins nobody finished.
 */
import { isValidId, randomId } from "../ids";

/** Long enough to walk through a login, short enough that a link found later is dead. */
const TTL_MS = 15 * 60 * 1000;

/** 120 bits. This is the only thing standing between the callback and a stranger. */
const STATE_LENGTH = 24;

export interface OAuthState {
  chatId: number;
  /** The activity waiting to be posted, or null for a login started on its own. */
  recordId: string | null;
  expiresAt: string;
}

interface StoredState extends OAuthState {
  claimedAt?: string;
}

function stateKey(state: string): string {
  return `drafts/linkedin-state/${state}.json`;
}

/**
 * Mints a state and records what it stands for.
 *
 * The write is conditional on nothing already being there. A collision is
 * vanishingly unlikely at 120 bits, but "vanishingly unlikely" is not a reason
 * to let one silently overwrite another chat's pending post.
 */
export async function createState(
  bucket: R2Bucket,
  chatId: number,
  recordId: string | null,
  now: Date = new Date(),
): Promise<string | null> {
  const state = randomId(STATE_LENGTH);
  const stored: OAuthState = {
    chatId,
    recordId,
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };

  const written = await bucket.put(stateKey(state), JSON.stringify(stored), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });

  return written === null ? null : state;
}

/**
 * Spends a state, or refuses.
 *
 * Claiming is a conditional write against the etag just read, not a read
 * followed by a delete. A browser that prefetches the redirect, or a reload of
 * the callback URL, would otherwise pass the read twice and post the same
 * activity to LinkedIn twice — and a duplicate public post is not something a
 * later apology undoes. R2 decides, atomically, which of two racing claims wins.
 */
export async function takeState(
  bucket: R2Bucket,
  state: string,
  now: Date = new Date(),
): Promise<OAuthState | null> {
  // The state arrives as a query parameter from the open internet and is about
  // to become an object key, so its shape is checked before it names anything.
  if (!isValidId(state)) return null;

  const key = stateKey(state);
  const object = await bucket.get(key);
  if (object === null) return null;

  let parsed: StoredState;
  try {
    parsed = (await object.json()) as StoredState;
  } catch {
    return null;
  }

  if (typeof parsed?.chatId !== "number" || typeof parsed.expiresAt !== "string") return null;
  if (parsed.claimedAt !== undefined) return null;
  if (Date.parse(parsed.expiresAt) <= now.getTime()) return null;

  const claimed = await bucket.put(
    key,
    JSON.stringify({ ...parsed, claimedAt: now.toISOString() }),
    { onlyIf: { etagMatches: object.etag }, httpMetadata: { contentType: "application/json" } },
  );

  // Someone else spent it between the read and the write.
  if (claimed === null) return null;

  return {
    chatId: parsed.chatId,
    recordId: typeof parsed.recordId === "string" ? parsed.recordId : null,
    expiresAt: parsed.expiresAt,
  };
}
