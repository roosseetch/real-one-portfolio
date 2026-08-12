/**
 * The LinkedIn member credential, stored in the private bucket.
 *
 * It lives in R2 rather than in a Worker secret for one reason: it expires. A
 * member access token is good for 60 days, and refresh tokens are only issued
 * to apps LinkedIn has approved for them — so the ordinary case is that the
 * author has to log in again, and the Worker has to be able to write the result
 * without a deploy. A secret cannot be replaced from inside the Worker.
 *
 * The key is deliberately outside `drafts/`. That prefix has a seven-day
 * lifecycle rule (infrastructure/main/lifecycle.tf), which would silently delete
 * a working credential on its eighth day and present as "LinkedIn keeps logging
 * me out" with nothing in any log.
 */

import type { GrantedToken } from "./oauth";

const TOKEN_KEY = "linkedin/token.json";

/**
 * A token is refreshed before it is this close to expiring, so a post never
 * races the clock between the check and the call.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface LinkedInToken {
  accessToken: string;
  /** ISO 8601. Derived from the `expires_in` LinkedIn returns, which is relative. */
  expiresAt: string;
  /** Absent unless the app is approved for programmatic refresh. Null is normal, not a fault. */
  refreshToken: string | null;
  refreshExpiresAt: string | null;
  /** `urn:li:person:<sub>`, read once from /v2/userinfo at connection time. */
  authorUrn: string;
  connectedAt: string;
}

/**
 * Turns what LinkedIn granted into what is stored.
 *
 * The relative `expires_in` becomes an instant here, once, so nothing later has
 * to remember when the grant was made. A refresh that returns no new refresh
 * token keeps the previous one, which is how LinkedIn expects it to be used.
 */
export function tokenFromGrant(
  grant: GrantedToken,
  authorUrn: string,
  previous: LinkedInToken | null = null,
  now: Date = new Date(),
): LinkedInToken {
  const refreshToken = grant.refreshToken ?? previous?.refreshToken ?? null;

  return {
    accessToken: grant.accessToken,
    expiresAt: new Date(now.getTime() + grant.expiresIn * 1000).toISOString(),
    refreshToken,
    refreshExpiresAt:
      grant.refreshExpiresIn === null
        ? // Only carried over alongside the refresh token it describes: keeping
          // an old expiry against a new token would date it wrongly.
          (grant.refreshToken === null ? (previous?.refreshExpiresAt ?? null) : null)
        : new Date(now.getTime() + grant.refreshExpiresIn * 1000).toISOString(),
    authorUrn,
    connectedAt: now.toISOString(),
  };
}

export async function saveToken(bucket: R2Bucket, token: LinkedInToken): Promise<void> {
  await bucket.put(TOKEN_KEY, JSON.stringify(token), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Null covers "never connected" and "the stored object is not a token we can
 * read". Both mean the same thing to every caller: there is no credential, so
 * the author has to log in.
 */
export async function loadToken(bucket: R2Bucket): Promise<LinkedInToken | null> {
  const object = await bucket.get(TOKEN_KEY);
  if (object === null) return null;

  let parsed: unknown;
  try {
    parsed = await object.json();
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const token = parsed as LinkedInToken;
  if (typeof token.accessToken !== "string" || token.accessToken === "") return null;
  if (typeof token.authorUrn !== "string" || token.authorUrn === "") return null;
  if (typeof token.expiresAt !== "string") return null;

  return {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    refreshToken: typeof token.refreshToken === "string" ? token.refreshToken : null,
    refreshExpiresAt: typeof token.refreshExpiresAt === "string" ? token.refreshExpiresAt : null,
    authorUrn: token.authorUrn,
    connectedAt: typeof token.connectedAt === "string" ? token.connectedAt : token.expiresAt,
  };
}

export async function clearToken(bucket: R2Bucket): Promise<void> {
  await bucket.delete(TOKEN_KEY);
}

/** True while the access token has enough life left to be worth trying. */
export function isUsable(token: LinkedInToken, now: Date = new Date()): boolean {
  const expiry = Date.parse(token.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - REFRESH_MARGIN_MS > now.getTime();
}

/** True when a refresh is worth attempting: there is a refresh token and it has not itself expired. */
export function canRefresh(token: LinkedInToken, now: Date = new Date()): boolean {
  if (token.refreshToken === null) return false;
  if (token.refreshExpiresAt === null) return true;

  const expiry = Date.parse(token.refreshExpiresAt);
  return !Number.isNaN(expiry) && expiry > now.getTime();
}
