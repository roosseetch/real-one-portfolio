/**
 * The answer shape both contact endpoints share.
 *
 * Extracted when `/contact/verify` arrived rather than copied: two endpoints
 * that disagree about which origins they allow is the kind of difference nobody
 * notices until one of them is the way in.
 */

export interface ContactOriginEnv {
  SITE_BASE_URL: string;
}

/** Null when the deployment has no site origin configured, which allows nothing. */
export function siteOrigin(env: ContactOriginEnv): string | null {
  try {
    return new URL(env.SITE_BASE_URL).origin;
  } catch {
    return null;
  }
}

export function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
}

/**
 * A JSON answer, with the CORS headers when there is an origin to send them to.
 *
 * A null origin means the request was refused before the origin was established,
 * and it gets no CORS headers at all: a page that is not allowed to read the
 * answer should not be told what it says.
 */
export function answer(status: number, origin: string | null, body?: Record<string, string>): Response {
  const headers = origin === null ? new Headers() : corsHeaders(origin);
  // Fetch forbids a body on 204, including an empty string.
  if (status === 204) return new Response(null, { status, headers });

  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body ?? { status: "refused" }), { status, headers });
}

/**
 * The checks every contact endpoint runs first: an origin it recognises, a
 * preflight answered, and nothing but POST past this point.
 *
 * Returns a Response to send back, or the allowed origin to carry on with.
 */
export function guard(request: Request, env: ContactOriginEnv): Response | string {
  const allowed = siteOrigin(env);
  if (allowed === null) return answer(503, null);
  if (request.headers.get("Origin") !== allowed) return answer(403, null);

  if (request.method === "OPTIONS") return answer(204, allowed);
  if (request.method !== "POST") return answer(405, allowed);

  return allowed;
}
