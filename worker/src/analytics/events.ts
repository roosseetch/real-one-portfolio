/**
 * The Worker's own Amplitude events, for the parts of the contact funnel that
 * must be recorded whether or not the browser managed to record anything.
 *
 * The relay next door (proxy.ts) covers a visitor whose request to Amplitude is
 * rejected. It does not cover one where the SDK never ran at all, and it can
 * only report what the page thought happened. These events are the Worker's own
 * account of what it did — a code mailed, an address proved, a message taken —
 * and they carry the outcome of every branch that got past the challenge, so a
 * refused code is as visible as an accepted one.
 *
 * Nothing here may throw into a request. A visitor's message must not fail
 * because an analytics vendor did.
 */
import { randomId } from "../ids";
import { AMPLITUDE_HTTP_V2 } from "./ingestion";

export interface ServerAnalyticsEnv {
  AMPLITUDE_API_KEY: string | undefined;
}

/**
 * Only what is needed to defer the upload. The router hands over the tracked
 * context from logging/error-log.ts, so the request's log waits for this the
 * way it waits for every other deferred call.
 */
export interface DeferContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The Amplitude device and session the page is already using, handed over by the
 * browser so a server-side event lands on that visitor rather than inventing a
 * second one. Absent when the site ships without analytics, when the SDK failed
 * to start, or when an older bundle is still cached.
 */
export interface ClientIdentity {
  deviceId: string;
  sessionId: number | null;
}

export interface ServerEvent {
  type: string;
  /** The proved address, on the events where the address has actually been proved. */
  userId?: string;
  properties?: Record<string, unknown>;
}

/**
 * What the Browser SDK's device ids look like: a UUID, in practice, but read as
 * a shape rather than as a format so a future SDK version is not refused. The
 * ceiling and the character class are what keep a stranger's field from becoming
 * an arbitrary payload in somebody else's Amplitude project.
 */
const DEVICE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The address sent for an event no visitor made. It is unroutable, so a reverse
 * lookup answers with nothing at all rather than with somewhere plausible.
 */
const UNKNOWN_LOCATION = "0.0.0.0";

/**
 * Reads the optional `analytics` object off a request body.
 *
 * Anything unusable reads as absent rather than refusing the request. This is a
 * field a stranger controls on the way to sending a message, and analytics is
 * never a good reason to turn a real message away.
 */
export function parseClientIdentity(value: unknown): ClientIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const candidate = value as { deviceId?: unknown; sessionId?: unknown };
  if (typeof candidate.deviceId !== "string" || !DEVICE_ID.test(candidate.deviceId)) return null;

  // A session id is Amplitude's start-of-session timestamp. Without a usable one
  // the event still belongs to the right device; it just floats outside the
  // session, which is better than attaching it to a made-up one.
  const sessionId =
    typeof candidate.sessionId === "number" && Number.isSafeInteger(candidate.sessionId) && candidate.sessionId > 0
      ? candidate.sessionId
      : null;

  return { deviceId: candidate.deviceId, sessionId };
}

/**
 * Sends every event of one request in a single upload, and returns immediately.
 *
 * Deferred rather than awaited: the visitor is waiting on an answer, and none of
 * this changes what the answer says.
 */
export function trackServerEvents(
  env: ServerAnalyticsEnv,
  ctx: DeferContext,
  /**
   * The visitor's own request, when the event is something they just did.
   *
   * Null when it is not: the contact check's verdict arrives on a callback from
   * a GitHub Actions runner, whose address and user agent describe the runner.
   * Sending those would move the visitor to a datacentre and give them a
   * device they have never used.
   */
  request: Request | null,
  identity: ClientIdentity | null,
  events: ServerEvent[],
): void {
  // A deployment with no key ships without analytics, exactly as the relay
  // answers 503 without one. Nothing to send to, and nothing to say about it.
  if (!env.AMPLITUDE_API_KEY || events.length === 0) return;

  // A device the page named, or one minted here. The events still have to land,
  // and a property saying which it was keeps the data honest about whether this
  // visitor's browser events are joined to these or not.
  const deviceId = identity?.deviceId ?? `worker-${randomId(16)}`;
  const stitched = identity !== null;

  // Amplitude resolves country and city from whichever address opened the
  // connection, which here is a Cloudflare one. Its HTTP V2 API reads a
  // per-event `ip`, so the visitor's address goes there — the same lesson
  // proxy.ts records for relayed events.
  //
  // With no visitor request behind the event, an address that cannot resolve to
  // anywhere is sent instead. Leaving it out would let Amplitude fall back to
  // whichever machine opened the connection, and no location is truthful where
  // a wrong one is not.
  const ip = request === null ? UNKNOWN_LOCATION : request.headers.get("CF-Connecting-IP");
  const sessionId = identity?.sessionId ?? null;
  const time = Date.now();

  const payload = JSON.stringify({
    api_key: env.AMPLITUDE_API_KEY,
    events: events.map((event) => ({
      event_type: event.type,
      device_id: deviceId,
      ...(event.userId === undefined ? {} : { user_id: event.userId }),
      ...(sessionId === null ? {} : { session_id: sessionId }),
      time,
      // Nothing retries this upload, so this is not about a duplicate delivery.
      // It is what lets one be sent again by hand, later, without counting twice.
      insert_id: crypto.randomUUID(),
      ...(ip === null ? {} : { ip }),
      event_properties: { source: "worker", stitched, ...event.properties },
    })),
  });

  // The browser's user agent, for the same device properties a direct upload
  // would carry. Cookies, Origin and the Cloudflare headers are deliberately not
  // forwarded, as in the relay.
  const headers = new Headers({ "content-type": "application/json" });
  const userAgent = request?.headers.get("user-agent");
  if (userAgent) headers.set("user-agent", userAgent);

  ctx.waitUntil(send(headers, payload));
}

/**
 * One upload, whose failure is a warning and nothing more.
 *
 * `console.warn` rather than `console.error` on purpose: warnings are not
 * persisted unless something else in the request failed (logging/error-log.ts),
 * and visitor traffic must not be able to write one durable log object per
 * event during an Amplitude outage. Status only — an address must never reach a
 * log line.
 */
async function send(headers: Headers, body: string): Promise<void> {
  try {
    const response = await fetch(AMPLITUDE_HTTP_V2, { method: "POST", headers, body });
    if (!response.ok) console.warn(`Amplitude refused a Worker event: ${response.status}`);
  } catch {
    console.warn("Amplitude ingestion could not be reached");
  }
}
