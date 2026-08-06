import { afterEach, describe, expect, it, vi } from "vitest";

import { handleAnalyticsProxy } from "./proxy";

const ORIGIN = "https://dinahaman.com";
const API_KEY = "public-project-key";
const env = { SITE_BASE_URL: ORIGIN, AMPLITUDE_API_KEY: API_KEY };
const body = JSON.stringify({ api_key: API_KEY, events: [{ event_type: "[Amplitude] Page Viewed" }] });

function request(method = "POST", overrides: { origin?: string; body?: string } = {}): Request {
  return new Request("https://worker.dinahaman.com/analytics", {
    method,
    headers: {
      Origin: overrides.origin ?? ORIGIN,
      "content-type": "application/json",
      "user-agent": "Test Browser",
      "CF-Connecting-IP": "203.0.113.7",
      Cookie: "private-site-cookie=must-not-leave",
    },
    ...(method === "POST" ? { body: overrides.body ?? body } : {}),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Amplitude first-party proxy", () => {
  it("answers the browser preflight for the configured site only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await handleAnalyticsProxy(request("OPTIONS"), env);

    expect(result.status).toBe(204);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(result.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a valid SDK payload without forwarding site cookies", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 200, events_ingested: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await handleAnalyticsProxy(request(), env);

    expect(result.status).toBe(200);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api2.amplitude.com/2/httpapi");
    expect(init?.body).toBe(body);
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("user-agent")).toBe("Test Browser");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
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
