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

interface AmplitudePayload {
  api_key: string;
  events: unknown[];
}

function parsePayload(raw: string, apiKey: string): AmplitudePayload | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const candidate = payload as { api_key?: unknown; events?: unknown };
  if (candidate.api_key !== apiKey) return null;
  if (!Array.isArray(candidate.events) || candidate.events.length === 0) return null;
  return candidate as AmplitudePayload;
}

/**
 * Amplitude resolves country and city from whichever address opened the
 * connection, which for a relayed event is a Cloudflare one rather than the
 * visitor's—and it ignores X-Forwarded-For. Its HTTP V2 API does read a
 * per-event `ip`, so carry the visitor's address there. A direct request needs
 * nothing: it already arrives from the visitor's own connection.
 */
function withVisitorIp(payload: AmplitudePayload, clientIp: string | null): string {
  if (clientIp) {
    for (const event of payload.events) {
      if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
      const record = event as { ip?: unknown };
      if (record.ip === undefined) record.ip = clientIp;
    }
  }
  return JSON.stringify(payload);
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
  const payload = parsePayload(raw, env.AMPLITUDE_API_KEY);
  if (payload === null) return response(400, allowedOrigin);

  const body = withVisitorIp(payload, request.headers.get("CF-Connecting-IP"));
  // Stamping the address grows the body, so the ceiling has to hold for what
  // actually leaves rather than only for what arrived.
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return response(413, allowedOrigin);

  // Deliberately do not forward cookies, Origin, or Cloudflare headers. The
  // ingestion API needs the SDK payload and the browser user agent for the same
  // device properties a direct request would carry; location rides along in
  // each event's `ip`.
  const headers = new Headers({ "content-type": "application/json" });
  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers.set("user-agent", userAgent);

  let upstream: Response;
  try {
    upstream = await fetch(AMPLITUDE_HTTP_V2, { method: "POST", headers, body });
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
