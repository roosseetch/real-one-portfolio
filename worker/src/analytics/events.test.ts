/**
 * The Worker's own Amplitude events.
 *
 * Two properties matter more than the payload's shape. Nothing here may throw
 * into a request — a visitor's message must not fail because an analytics
 * vendor did — and nothing here may be a way for a stranger to write whatever
 * they like into somebody else's Amplitude project, which is what the identity
 * they hand over would otherwise be.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeferContext, type FakeDeferContext } from "../test-support/defer";
import { parseClientIdentity, trackServerEvents } from "./events";
import { AMPLITUDE_HTTP_V2 } from "./ingestion";

let defer: FakeDeferContext;
let uploads: Array<{ url: string; headers: Headers; payload: Payload }>;
let upstream: () => Response;

interface Payload {
  api_key: string;
  events: Array<Record<string, unknown>>;
}

beforeEach(() => {
  defer = createDeferContext();
  uploads = [];
  upstream = () => new Response(JSON.stringify({ code: 200 }));

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    uploads.push({
      url: String(url),
      headers: new Headers(init?.headers),
      payload: JSON.parse(String(init?.body)),
    });
    return upstream();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({ AMPLITUDE_API_KEY: "amplitude-key" });

function request({ ip = "203.0.113.7", userAgent = "Mozilla/5.0 (a browser)" } = {}): Request {
  const headers = new Headers();
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (userAgent) headers.set("user-agent", userAgent);
  return new Request("https://worker.example/contact", { method: "POST", headers });
}

const IDENTITY = { deviceId: "0f2b1c3d-4e5f-6789-abcd-ef0123456789", sessionId: 1_754_900_000_000 };

async function send(...args: Parameters<typeof trackServerEvents>): Promise<void> {
  trackServerEvents(...args);
  await defer.settled();
}

describe("reading the identity a browser offers", () => {
  it("takes a device and a session", () => {
    expect(parseClientIdentity(IDENTITY)).toEqual(IDENTITY);
  });

  it("keeps the device when the session is unusable, because the device is what stitches", () => {
    expect(parseClientIdentity({ ...IDENTITY, sessionId: "recent" })).toEqual({
      deviceId: IDENTITY.deviceId,
      sessionId: null,
    });
    expect(parseClientIdentity({ ...IDENTITY, sessionId: -1 })).toEqual({
      deviceId: IDENTITY.deviceId,
      sessionId: null,
    });
  });

  const refused: Array<[string, unknown]> = [
    ["nothing at all", undefined],
    ["an array", [IDENTITY]],
    ["a bare string", "0f2b1c3d"],
    ["no device", { sessionId: 1 }],
    ["a device that is not a string", { deviceId: 7 }],
    ["an empty device", { deviceId: "" }],
    ["a device longer than the ceiling", { deviceId: "d".repeat(65) }],
    ["a device carrying anything but a device", { deviceId: 'x", "user_id": "someone-else' }],
  ];

  for (const [what, value] of refused) {
    it(`reads ${what} as no identity rather than refusing`, () => {
      expect(parseClientIdentity(value)).toBeNull();
    });
  }
});

describe("what is sent", () => {
  it("sends nothing at all without a key, because that deployment has no analytics", async () => {
    const event = [{ type: "contact_code_requested" }];
    // Unset, and set to the empty string a repository variable nobody filled in
    // reaches the Worker as. Both mean the same thing.
    await send({ AMPLITUDE_API_KEY: undefined }, defer.ctx, request(), IDENTITY, event);
    await send({ AMPLITUDE_API_KEY: "" }, defer.ctx, request(), IDENTITY, event);

    expect(uploads).toEqual([]);
  });

  it("sends nothing for an empty list", async () => {
    await send(env(), defer.ctx, request(), IDENTITY, []);

    expect(uploads).toEqual([]);
  });

  it("posts one upload to Amplitude's ingestion API, carrying the key", async () => {
    await send(env(), defer.ctx, request(), IDENTITY, [
      { type: "contact_address_checked", userId: "visitor@example.com", properties: { outcome: "accepted" } },
      { type: "contact_message_submitted", userId: "visitor@example.com", properties: { outcome: "accepted" } },
    ]);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe(AMPLITUDE_HTTP_V2);
    expect(uploads[0].payload.api_key).toBe("amplitude-key");
    expect(uploads[0].payload.events).toHaveLength(2);
    expect(uploads[0].headers.get("content-type")).toBe("application/json");
  });

  it("files the event under the device and session the page is already using", async () => {
    await send(env(), defer.ctx, request(), IDENTITY, [{ type: "contact_code_requested" }]);

    const [event] = uploads[0].payload.events;
    expect(event.device_id).toBe(IDENTITY.deviceId);
    expect(event.session_id).toBe(IDENTITY.sessionId);
    expect(event.event_properties).toMatchObject({ source: "worker", stitched: true });
  });

  it("mints a device when the page offered none, and says the event is not stitched", async () => {
    await send(env(), defer.ctx, request(), null, [{ type: "contact_code_requested" }]);

    const [event] = uploads[0].payload.events;
    expect(String(event.device_id)).toMatch(/^worker-[0-9a-z]{16}$/);
    expect(event).not.toHaveProperty("session_id");
    expect(event.event_properties).toMatchObject({ stitched: false });
  });

  it("leaves out the session when the page had a device but no usable session", async () => {
    await send(env(), defer.ctx, request(), { deviceId: IDENTITY.deviceId, sessionId: null }, [
      { type: "contact_code_requested" },
    ]);

    expect(uploads[0].payload.events[0]).not.toHaveProperty("session_id");
    expect(uploads[0].payload.events[0].event_properties).toMatchObject({ stitched: true });
  });

  it("names the user only on the events that were given one", async () => {
    await send(env(), defer.ctx, request(), IDENTITY, [
      { type: "contact_address_checked", properties: { outcome: "rejected" } },
      { type: "contact_message_submitted", userId: "visitor@example.com" },
    ]);

    const [refusedEvent, acceptedEvent] = uploads[0].payload.events;
    expect(refusedEvent).not.toHaveProperty("user_id");
    expect(acceptedEvent.user_id).toBe("visitor@example.com");
  });

  it("carries the visitor's address and user agent, or the event geolocates to the edge", async () => {
    await send(env(), defer.ctx, request(), IDENTITY, [{ type: "contact_code_requested" }]);

    expect(uploads[0].payload.events[0].ip).toBe("203.0.113.7");
    expect(uploads[0].headers.get("user-agent")).toBe("Mozilla/5.0 (a browser)");
  });

  it("sends the event without an address rather than not at all", async () => {
    await send(env(), defer.ctx, request({ ip: "", userAgent: "" }), IDENTITY, [{ type: "contact_code_requested" }]);

    expect(uploads[0].payload.events[0]).not.toHaveProperty("ip");
    expect(uploads[0].headers.get("user-agent")).toBeNull();
  });

  it("gives every event its own insert id, so one resent by hand does not count twice", async () => {
    await send(env(), defer.ctx, request(), IDENTITY, [
      { type: "contact_address_checked" },
      { type: "contact_message_submitted" },
    ]);

    const [first, second] = uploads[0].payload.events;
    expect(String(first.insert_id)).toHaveLength(36);
    expect(first.insert_id).not.toBe(second.insert_id);
  });

  it("does not forward the cookies or the origin a relayed request would not either", async () => {
    await send(env(), defer.ctx, request(), IDENTITY, [{ type: "contact_code_requested" }]);

    expect(uploads[0].headers.get("cookie")).toBeNull();
    expect(uploads[0].headers.get("origin")).toBeNull();
  });
});

describe("when Amplitude is not there", () => {
  it("warns and does not throw when the upload is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream = () => new Response("no", { status: 429 });

    await send(env(), defer.ctx, request(), IDENTITY, [{ type: "contact_code_requested" }]);

    expect(warn).toHaveBeenCalledWith("Amplitude refused a Worker event: 429");
  });

  it("warns and does not throw when it cannot be reached at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream = () => {
      throw new Error("network down");
    };

    await send(env(), defer.ctx, request(), IDENTITY, [{ type: "contact_code_requested" }]);

    expect(warn).toHaveBeenCalledWith("Amplitude ingestion could not be reached");
  });

  it("says nothing durable about a refusal, so an outage cannot fill the log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream = () => new Response("no", { status: 500 });

    await send(env(), defer.ctx, request(), IDENTITY, [{ type: "contact_code_requested" }]);

    expect(error).not.toHaveBeenCalled();
  });
});
