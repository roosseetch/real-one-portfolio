/**
 * What this browser remembers about addresses it has already proved.
 *
 * The Worker hands out a token when a code is redeemed, and keeping it here is
 * what lets somebody write a second time without going back to their inbox. The
 * token is the whole claim: the Worker checks it against the one it issued, so
 * a value invented here proves nothing and is refused.
 *
 * Addresses are stored under a hash rather than in the open. This is somebody's
 * email address sitting in a browser that may be shared or borrowed, and nothing
 * here ever needs to read the address back — only to answer "is there a token
 * for this one", which a hash answers just as well.
 *
 * Every failure is swallowed. Storage that is full, disabled, or refused in a
 * private window means the visitor types a code, which is the same thing that
 * happens the first time and needs no explaining.
 */

const KEY = "contact.verified.v1";

/** Kept in step with the Worker's own window (worker/src/contact/codes.ts). */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Remembered {
  token: string;
  /** Milliseconds since the epoch. Read back as a number, never trusted as one. */
  expiresAt: number;
}

type Store = Record<string, Remembered>;

/**
 * The lookup key: a hash of the address, so what is left behind on a shared
 * computer is opaque.
 *
 * SHA-256 through the platform's own crypto, truncated — this is a map key, not
 * a defence against somebody who already has the address and wants to confirm
 * it. It keeps a plain address out of a place people can read by accident.
 */
async function keyFor(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    // Every entry is checked rather than trusted: this is a value a person can
    // edit by hand, and a malformed one must not throw on the way to a form.
    const store: Store = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<Remembered>;
      if (typeof entry?.token === "string" && typeof entry?.expiresAt === "number") {
        store[key] = { token: entry.token, expiresAt: entry.expiresAt };
      }
    }
    return store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Full, disabled, or a private window. The visitor types a code instead.
  }
}

/** Drops what has expired, so the entry that matters is the only one kept. */
function withoutExpired(store: Store, now: number): Store {
  return Object.fromEntries(Object.entries(store).filter(([, entry]) => entry.expiresAt > now));
}

/** The token for this address, or null when there is none worth presenting. */
export async function recall(email: string, now: number = Date.now()): Promise<string | null> {
  const entry = read()[await keyFor(email)];
  return entry !== undefined && entry.expiresAt > now ? entry.token : null;
}

/** Keeps the token, and takes the opportunity to clear out anything stale. */
export async function remember(email: string, token: string, now: number = Date.now()): Promise<void> {
  const store = withoutExpired(read(), now);
  store[await keyFor(email)] = { token, expiresAt: now + TTL_MS };
  write(store);
}

/**
 * Forgets this address, for when the Worker refuses the token it was given.
 *
 * A refused token is not worth keeping under any reading: either it has been
 * retired by a later verification elsewhere, or the record it belonged to has
 * aged out. Both mean the same thing to the visitor — type a code.
 */
export async function forget(email: string, now: number = Date.now()): Promise<void> {
  const store = withoutExpired(read(), now);
  delete store[await keyFor(email)];
  write(store);
}
