/**
 * First-party fallback relay for Amplitude Browser SDK events.
 *
 * The browser tries api2.amplitude.com first and calls this route only when
 * that direct request is rejected. Checking both the public project key and
 * site origin keeps this from becoming a generic relay.
 */

const AMPLITUDE_HTTP_V2 = "https://api2.amplitude.com/2/httpapi";
const MAX_BODY_BYTES = 128 * 1024;

export interface AnalyticsProxyEnv {
  AMPLITUDE_API_KEY: string | undefined;
  SITE_BASE_URL: string;
}

function siteOrigin(env: AnalyticsProxyEnv): string | null {
  try {
    return new URL(env.SITE_BASE_URL).origin;
  } catch {
    return null;
  }
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
}

function response(status: number, origin: string | null, body = ""): Response {
  const headers = origin === null ? new Headers() : corsHeaders(origin);
  // Fetch forbids a body on 204, including an empty string.
  return new Response(status === 204 ? null : body, { status, headers });
}

function validPayload(raw: string, apiKey: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return false;
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const candidate = payload as { api_key?: unknown; events?: unknown };
  return candidate.api_key === apiKey && Array.isArray(candidate.events) && candidate.events.length > 0;
}

export async function handleAnalyticsProxy(request: Request, env: AnalyticsProxyEnv): Promise<Response> {
  const allowedOrigin = siteOrigin(env);
  const presentedOrigin = request.headers.get("Origin");

  if (allowedOrigin === null || !env.AMPLITUDE_API_KEY) return response(503, null);
  if (presentedOrigin !== allowedOrigin) return response(403, null);

  if (request.method === "OPTIONS") {
    return response(204, allowedOrigin);
  }

  if (request.method !== "POST") return response(405, allowedOrigin);

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return response(413, allowedOrigin);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return response(413, allowedOrigin);
  if (!validPayload(raw, env.AMPLITUDE_API_KEY)) return response(400, allowedOrigin);

  // Deliberately do not forward cookies, Origin, or Cloudflare headers. The
  // ingestion API needs the SDK payload, browser user agent, and originating
  // IP for the same device/location properties a direct request would carry.
  const headers = new Headers({ "content-type": "application/json" });
  const userAgent = request.headers.get("user-agent");
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (userAgent) headers.set("user-agent", userAgent);
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  let upstream: Response;
  try {
    upstream = await fetch(AMPLITUDE_HTTP_V2, { method: "POST", headers, body: raw });
  } catch {
    // Visitor traffic must not create one durable error-log object per event
    // during an upstream outage. The SDK sees 502 and retains its own retry.
    console.warn("Amplitude ingestion could not be reached");
    return response(502, allowedOrigin);
  }

  const outgoing = corsHeaders(allowedOrigin);
  const contentType = upstream.headers.get("content-type");
  const retryAfter = upstream.headers.get("retry-after");
  if (contentType) outgoing.set("content-type", contentType);
  if (retryAfter) outgoing.set("retry-after", retryAfter);

  return new Response(upstream.body, { status: upstream.status, headers: outgoing });
}
