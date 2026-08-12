/**
 * LinkedIn's three-legged OAuth, from this Worker's side.
 *
 * Nothing here throws. A LinkedIn outage must not turn a button press into a
 * 500 and a Telegram redelivery, so every call returns a result the caller
 * decides what to do with — the same rule telegram/api.ts follows.
 *
 * Scopes are the least that does the job: `w_member_social` to post, and
 * `openid profile` only because the member's own URN has to be read from
 * /v2/userinfo before anything can be authored on their behalf.
 */

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

const SCOPES = "openid profile w_member_social";

/**
 * Must match the route in index.ts and the redirect URL registered on the
 * LinkedIn app. A constant rather than a configured value for the same reason
 * the webhook path is one: a hand-typed URL with a typo is accepted at
 * registration and only fails much later, at the one moment it matters.
 */
export const CALLBACK_PATH = "/linkedin/callback";

export interface LinkedInOAuthEnv {
  // Declared as possibly undefined because a value that was never set arrives
  // that way at runtime, whatever the Env interface claims. This is the whole
  // feature switch: without both, the Worker says LinkedIn is not configured
  // rather than building a login link to nowhere.
  LINKEDIN_CLIENT_ID: string | undefined;
  LINKEDIN_CLIENT_SECRET: string | undefined;
  WORKER_BASE_URL: string | undefined;
}

/** True when this deployment has been given everything the LinkedIn flow needs. */
export function isConfigured(env: LinkedInOAuthEnv): boolean {
  return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.WORKER_BASE_URL);
}

export function redirectUri(env: LinkedInOAuthEnv): string {
  return `${(env.WORKER_BASE_URL ?? "").replace(/\/$/, "")}${CALLBACK_PATH}`;
}

/**
 * The link the author taps to log in.
 *
 * `state` is minted and stored by the caller; LinkedIn hands it straight back on
 * the callback, and it is the only thing tying a redirect from the open internet
 * to a request this Worker actually made.
 */
export function authorizeUrl(env: LinkedInOAuthEnv, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", redirectUri(env));
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPES);
  return url.toString();
}

export interface GrantedToken {
  accessToken: string;
  /** Seconds, as LinkedIn reports it. Turned into an instant by the caller. */
  expiresIn: number;
  refreshToken: string | null;
  refreshExpiresIn: number | null;
}

export type TokenResult = { status: "granted"; token: GrantedToken } | { status: "failed" };

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
}

/**
 * One place where the client secret is put into a request body, so it is one
 * place to check that no log statement ever sees it. LinkedIn wants
 * form-encoded here, not JSON.
 */
async function requestToken(body: URLSearchParams, what: string): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    console.warn(`LinkedIn ${what} could not be delivered`);
    return { status: "failed" };
  }

  if (!response.ok) {
    // Status only. The body of a rejected token request quotes back part of
    // what was sent, and what was sent includes the client secret.
    console.warn(`LinkedIn ${what} failed with status ${response.status}`);
    return { status: "failed" };
  }

  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    console.warn(`LinkedIn ${what} returned an unreadable body`);
    return { status: "failed" };
  }

  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    console.warn(`LinkedIn ${what} returned no access token`);
    return { status: "failed" };
  }

  return {
    status: "granted",
    token: {
      accessToken: payload.access_token,
      // A missing expiry reads as already expired rather than as forever, so a
      // credential nobody can vouch for is re-authorised instead of trusted.
      expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : 0,
      // Absent for an app not approved for programmatic refresh, which is the
      // common case. Null here is what puts the login link in front of the
      // author sixty days from now.
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
      refreshExpiresIn:
        typeof payload.refresh_token_expires_in === "number" ? payload.refresh_token_expires_in : null,
    },
  };
}

export async function exchangeCode(env: LinkedInOAuthEnv, code: string): Promise<TokenResult> {
  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      // LinkedIn checks this against the one used on the authorize call and
      // rejects the exchange if they differ, so it is rebuilt the same way.
      redirect_uri: redirectUri(env),
      client_id: env.LINKEDIN_CLIENT_ID ?? "",
      client_secret: env.LINKEDIN_CLIENT_SECRET ?? "",
    }),
    "code exchange",
  );
}

export async function refreshAccessToken(
  env: LinkedInOAuthEnv,
  refreshToken: string,
): Promise<TokenResult> {
  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.LINKEDIN_CLIENT_ID ?? "",
      client_secret: env.LINKEDIN_CLIENT_SECRET ?? "",
    }),
    "token refresh",
  );
}

/**
 * The member's own URN, which every post has to name as its author.
 *
 * Read once at connection time and stored beside the token, rather than before
 * each post: it never changes for a given member, and a second call per post
 * would be one more thing that can fail between "yes, publish" and publishing.
 */
export async function fetchAuthorUrn(accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    console.warn("LinkedIn userinfo could not be reached");
    return null;
  }

  if (!response.ok) {
    console.warn(`LinkedIn userinfo failed with status ${response.status}`);
    return null;
  }

  let payload: { sub?: unknown };
  try {
    payload = (await response.json()) as { sub?: unknown };
  } catch {
    return null;
  }

  // `sub` is the member id under OpenID Connect. Checked rather than assumed:
  // it is about to be pasted into a URN that names who authored a public post.
  if (typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.sub)) {
    console.warn("LinkedIn userinfo returned no usable member id");
    return null;
  }

  return `urn:li:person:${payload.sub}`;
}
