import { afterEach, describe, expect, it, vi } from "vitest";

import { handleAnalyticsProxy } from "./proxy";

const ORIGIN = "https://dinahaman.com";
const API_KEY = "public-project-key";
const env = { SITE_BASE_URL: ORIGIN, AMPLITUDE_API_KEY: API_KEY };
const body = JSON.stringify({ api_key: API_KEY, events: [{ event_type: "[Amplitude] Page Viewed" }] });

function request(
  method = "POST",
  overrides: { origin?: string; body?: string; clientIp?: string | null } = {},
): Request {
  const headers: Record<string, string> = {
    Origin: overrides.origin ?? ORIGIN,
    "content-type": "application/json",
    "user-agent": "Test Browser",
    Cookie: "private-site-cookie=must-not-leave",
  };
  const clientIp = overrides.clientIp === undefined ? "203.0.113.7" : overrides.clientIp;
  if (clientIp !== null) headers["CF-Connecting-IP"] = clientIp;

  return new Request("https://worker.dinahaman.com/analytics", {
    method,
    headers,
    ...(method === "POST" ? { body: overrides.body ?? body } : {}),
  });
}

function sentEvents(init: RequestInit | undefined): Record<string, unknown>[] {
  return JSON.parse(String(init?.body)).events as Record<string, unknown>[];
}

function okResponse(): Response {
  return new Response(JSON.stringify({ code: 200, events_ingested: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Amplitude fallback proxy", () => {
  it("answers the browser preflight for the configured site only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await handleAnalyticsProxy(request("OPTIONS"), env);

    expect(result.status).toBe(204);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(result.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a valid SDK payload without forwarding site cookies", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());

    const result = await handleAnalyticsProxy(request(), env);

    expect(result.status).toBe(200);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api2.amplitude.com/2/httpapi");
    expect(JSON.parse(String(init?.body)).api_key).toBe(API_KEY);
    expect(sentEvents(init)[0].event_type).toBe("[Amplitude] Page Viewed");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("user-agent")).toBe("Test Browser");
  });

  // Amplitude geolocates from the connecting address, which for a relayed event
  // is Cloudflare's. Without this every fallback visitor lands in the wrong country.
  it("stamps the visitor address onto each event so Amplitude geolocates the visitor", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    const two = JSON.stringify({
      api_key: API_KEY,
      events: [{ event_type: "session_start" }, { event_type: "page_engaged" }],
    });

    await handleAnalyticsProxy(request("POST", { body: two }), env);

    expect(sentEvents(fetchSpy.mock.calls[0][1]).map((event) => event.ip)).toEqual([
      "203.0.113.7",
      "203.0.113.7",
    ]);
    expect(new Headers(fetchSpy.mock.calls[0][1]?.headers).get("x-forwarded-for")).toBeNull();
  });

  it("leaves an address the SDK already set alone", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    const preset = JSON.stringify({
      api_key: API_KEY,
      events: [{ event_type: "session_start", ip: "198.51.100.4" }],
    });

    await handleAnalyticsProxy(request("POST", { body: preset }), env);

    expect(sentEvents(fetchSpy.mock.calls[0][1])[0].ip).toBe("198.51.100.4");
  });

  it("still forwards when Cloudflare supplies no visitor address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());

    const result = await handleAnalyticsProxy(request("POST", { clientIp: null }), env);

    expect(result.status).toBe(200);
    expect(sentEvents(fetchSpy.mock.calls[0][1])[0].ip).toBeUndefined();
  });

  it("refuses a payload that only exceeds the ceiling once addresses are stamped", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Each stamp adds ~20 bytes, so enough events tip a legal body over the edge.
    const events = Array.from({ length: 4000 }, () => ({ event_type: "page_scrolled" }));
    const large = JSON.stringify({ api_key: API_KEY, events });
    expect(new TextEncoder().encode(large).byteLength).toBeLessThan(128 * 1024);

    const result = await handleAnalyticsProxy(request("POST", { body: large }), env);

    expect(result.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses another browser origin before reading or forwarding it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await handleAnalyticsProxy(request("POST", { origin: "https://evil.example" }), env);

    expect(result.status).toBe(403);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a payload for a different Amplitude project", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const wrong = JSON.stringify({ api_key: "another-project", events: [{ event_type: "visit" }] });
    const result = await handleAnalyticsProxy(request("POST", { body: wrong }), env);

    expect(result.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a CORS-readable 502 when Amplitude is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    const result = await handleAnalyticsProxy(request(), env);

    expect(result.status).toBe(502);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});
