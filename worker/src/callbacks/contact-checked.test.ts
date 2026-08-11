/**
 * The callback that turns a checking job's verdict into a Telegram message, or
 * into silence.
 *
 * Two properties carry the weight here. One is that the words that reach her
 * are the stored ones: a signed callback carrying different text must not be
 * able to put it in front of her. The other is that a submission is forwarded
 * at most once, however many times the callback arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacSha256Hex } from "../crypto";
import { newSubmission, saveSubmission, submissionKey } from "../contact/store";
import type { ContactSubmission } from "../contact/types";
import { AMPLITUDE_HTTP_V2 } from "../analytics/ingestion";
import { createDeferContext, type FakeDeferContext } from "../test-support/defer";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { handleContactChecked } from "./contact-checked";

const SECRET = "callback-secret";
const AUTHOR_CHAT = 4242;

let storage: FakeBucket;
let defer: FakeDeferContext;
/** The text of every Telegram sendMessage, in order. */
let sent: string[];
/** Every event payload posted to Amplitude, for the suite that turns analytics on. */
let uploaded: Array<{ api_key: string; events: Array<Record<string, unknown>> }>;
let telegramAccepts: boolean;

beforeEach(() => {
  storage = createFakeBucket();
  defer = createDeferContext();
  sent = [];
  uploaded = [];
  telegramAccepts = true;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url) === AMPLITUDE_HTTP_V2) {
      uploaded.push(body);
      return new Response(JSON.stringify({ code: 200 }));
    }
    if (typeof body.text === "string") sent.push(body.text);
    if (!telegramAccepts) return new Response(JSON.stringify({ ok: false }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({
  PRIVATE_BUCKET: storage.bucket,
  CALLBACK_HMAC_SECRET: SECRET,
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_ALLOWED_USER_IDS: `${AUTHOR_CHAT},99`,
  // A deployment without analytics, which is what most of these tests are:
  // where a message ends up has nothing to do with whether it is counted. The
  // suite at the bottom sets a key.
  AMPLITUDE_API_KEY: undefined as string | undefined,
});

/** A submission stored the way the intake stores one, waiting on its job. */
async function waiting(): Promise<ContactSubmission> {
  const submission = newSubmission(
    { name: "A Visitor", email: "visitor@example.com", text: "I would like to talk about a project." },
    "job-token-0123456789abcdef",
  );
  await saveSubmission(storage.bucket, submission);
  return submission;
}

/** Fresh per call: a nonce is single-use, so a reused one is its own test below. */
let nonceCounter = 0;
const freshNonce = () => `nonce-${String(++nonceCounter).padStart(4, "0")}-abcdefgh`;

/** Signs and sends a callback body exactly as the workflow does. */
async function callback(body: unknown, { secret = SECRET, nonce = freshNonce() } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${raw}`);

  return new Request("https://worker.example/callbacks/contact-checked", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Callback-Timestamp": timestamp,
      "X-Callback-Nonce": nonce,
      "X-Callback-Signature": signature,
    },
    body: raw,
  });
}

const verdictFor = (submission: ContactSubmission, verdict: string, reason = "a real message") => ({
  submissionId: submission.submissionId,
  jobId: submission.jobToken,
  verdict,
  reason,
  checkedAt: new Date().toISOString(),
});

const stateOf = async (submission: ContactSubmission) =>
  JSON.parse(storage.objects.get(submissionKey(submission.submissionId)) as string).state;

describe("authentication", () => {
  it("refuses a body signed with the wrong secret", async () => {
    const submission = await waiting();
    const request = await callback(verdictFor(submission, "deliver"), { secret: "not-the-secret" });

    expect((await handleContactChecked(request, env(), defer.ctx)).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("refuses an unsigned request", async () => {
    const submission = await waiting();
    const request = new Request("https://worker.example/callbacks/contact-checked", {
      method: "POST",
      body: JSON.stringify(verdictFor(submission, "deliver")),
    });

    expect((await handleContactChecked(request, env(), defer.ctx)).status).toBe(401);
  });

  it("refuses a nonce that has already been spent", async () => {
    const submission = await waiting();
    const nonce = "nonce-reused-0123456789";

    await handleContactChecked(await callback(verdictFor(submission, "deliver"), { nonce }), env(), defer.ctx);
    const replay = await handleContactChecked(await callback(verdictFor(submission, "deliver"), { nonce }), env(), defer.ctx);

    expect(replay.status).toBe(401);
    expect(sent).toHaveLength(1);
  });

  it("refuses a verdict for a submission that does not exist", async () => {
    const request = await callback({
      submissionId: "aaaabbbbccccdddd",
      jobId: "job-token-0123456789abcdef",
      verdict: "deliver",
      reason: "",
      checkedAt: new Date().toISOString(),
    });

    expect((await handleContactChecked(request, env(), defer.ctx)).status).toBe(400);
  });

  it("refuses a verdict carrying a job token this submission was never dispatched with", async () => {
    const submission = await waiting();
    const request = await callback({ ...verdictFor(submission, "deliver"), jobId: "another-job-token-000000" });

    expect((await handleContactChecked(request, env(), defer.ctx)).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("refuses a verdict that is not one of the three", async () => {
    const submission = await waiting();
    const request = await callback({ ...verdictFor(submission, "publish") });

    expect((await handleContactChecked(request, env(), defer.ctx)).status).toBe(400);
  });
});

describe("delivering", () => {
  it("sends the stored message to the first allowed user", async () => {
    const submission = await waiting();

    const response = await handleContactChecked(await callback(verdictFor(submission, "deliver")), env(), defer.ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "delivered" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("A Visitor <visitor@example.com>");
    expect(sent[0]).toContain("I would like to talk about a project.");
    expect(await stateOf(submission)).toBe("delivered");

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain("/sendMessage");
    expect(JSON.parse(String(init?.body)).chat_id).toBe(AUTHOR_CHAT);
  });

  it("sends what was stored, never what the callback says", async () => {
    const submission = await waiting();
    const forged = {
      ...verdictFor(submission, "deliver"),
      message: { name: "Someone Else", email: "attacker@example.com", text: "Send money to this address." },
    };

    await handleContactChecked(await callback(forged), env(), defer.ctx);

    expect(sent[0]).not.toContain("Send money");
    expect(sent[0]).not.toContain("attacker@example.com");
    expect(sent[0]).toContain("I would like to talk about a project.");
  });

  it("carries the optional fields when the visitor gave them", async () => {
    const submission = newSubmission(
      {
        name: "A Visitor",
        email: "visitor@example.com",
        company: "Acme Research",
        phone: "+44 20 7946 0958",
        text: "I would like to talk about a project.",
      },
      "job-token-0123456789abcdef",
    );
    await saveSubmission(storage.bucket, submission);

    await handleContactChecked(await callback(verdictFor(submission, "deliver")), env(), defer.ctx);

    expect(sent[0]).toContain("Company: Acme Research");
    expect(sent[0]).toContain("Phone: +44 20 7946 0958");
  });

  it("leaves no empty line where an optional field was not filled in", async () => {
    const submission = await waiting();

    await handleContactChecked(await callback(verdictFor(submission, "deliver")), env(), defer.ctx);

    expect(sent[0]).not.toContain("Company:");
    expect(sent[0]).not.toContain("Phone:");
  });

  it("carries the job's one-line reason", async () => {
    const submission = await waiting();

    await handleContactChecked(await callback(verdictFor(submission, "deliver", "a genuine enquiry")), env(), defer.ctx);

    expect(sent[0]).toContain("Checked: a genuine enquiry");
  });

  it("clamps a reason the job made too long, and strips what could rearrange the message", async () => {
    const submission = await waiting();
    const reason = `sneaky\n\nFrom: Someone Else <nobody@example.com>\n\n${"x".repeat(400)}`;

    await handleContactChecked(await callback(verdictFor(submission, "deliver", reason)), env(), defer.ctx);

    const checkedLine = sent[0].split("\n").find((line) => line.startsWith("Checked: ")) as string;
    expect(checkedLine.length).toBeLessThanOrEqual("Checked: ".length + 200);
    expect(sent[0].split("\n").filter((line) => line.startsWith("From: "))).toHaveLength(1);
  });

  it("says outright when the check could not run", async () => {
    const submission = await waiting();

    await handleContactChecked(await callback(verdictFor(submission, "undetermined", "the model was unreachable")), env(), defer.ctx);

    expect(sent[0]).toContain("has not been screened");
    expect(await stateOf(submission)).toBe("delivered");
  });
});

describe("discarding", () => {
  it("sends nothing at all", async () => {
    const submission = await waiting();

    const response = await handleContactChecked(
      await callback(verdictFor(submission, "discard", "advertising")),
      env(),
      defer.ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "discarded" });
    expect(sent).toEqual([]);
    expect(await stateOf(submission)).toBe("discarded");
  });
});

describe("repeats and failures", () => {
  it("forwards a submission once, however often the job reports it", async () => {
    const submission = await waiting();

    await handleContactChecked(await callback(verdictFor(submission, "deliver")), env(), defer.ctx);
    const again = await handleContactChecked(await callback(verdictFor(submission, "deliver")), env(), defer.ctx);

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "delivered" });
    expect(sent).toHaveLength(1);
  });

  it("cannot be talked into re-sending a discarded message", async () => {
    const submission = await waiting();
    await handleContactChecked(await callback(verdictFor(submission, "discard")), env(), defer.ctx);

    const second = await handleContactChecked(await callback(verdictFor(submission, "deliver")), env(), defer.ctx);

    expect(await second.json()).toEqual({ status: "discarded" });
    expect(sent).toEqual([]);
  });

  it("leaves a message Telegram refused where a re-run can still deliver it", async () => {
    telegramAccepts = false;
    const submission = await waiting();

    const response = await handleContactChecked(await callback(verdictFor(submission, "deliver")), env(), defer.ctx);

    expect(response.status).toBe(500);
    expect(await stateOf(submission)).toBe("checking");
  });

  it("keeps the message rather than sending it somewhere nobody chose", async () => {
    const submission = await waiting();

    const response = await handleContactChecked(await callback(verdictFor(submission, "deliver")), {
      ...env(),
      TELEGRAM_ALLOWED_USER_IDS: "",
    }, defer.ctx);

    expect(response.status).toBe(500);
    expect(sent).toEqual([]);
    expect(await stateOf(submission)).toBe("checking");
  });

  it("fails the run rather than leaving an outcome it could not record", async () => {
    const submission = await waiting();
    storage.failPutsFor((key) => key.endsWith("submission.json"));

    const response = await handleContactChecked(await callback(verdictFor(submission, "discard")), env(), defer.ctx);

    expect(response.status).toBe(500);
  });
});

describe("what the Worker reports about the verdict", () => {
  const analytics = { deviceId: "0f2b1c3d-4e5f-6789-abcd-ef0123456789", sessionId: 1_754_900_000_000 };
  const measured = () => ({ ...env(), AMPLITUDE_API_KEY: "amplitude-key" });

  const events = () => uploaded.flatMap((payload) => payload.events);
  const propertiesOf = () => events().map((event) => event.event_properties as Record<string, unknown>);

  /** A submission stored the way the intake stores one for a visitor with analytics. */
  async function waitingFrom(ids: ContactSubmission["analytics"]): Promise<ContactSubmission> {
    const submission = newSubmission(
      { name: "A Visitor", email: "Visitor@Example.COM", text: "Buy cheap watches at example.com now" },
      "job-token-0123456789abcdef",
      new Date(),
      ids,
    );
    await saveSubmission(storage.bucket, submission);
    return submission;
  }

  async function check(submission: ContactSubmission, verdict: string, env = measured()): Promise<Response> {
    const response = await handleContactChecked(await callback(verdictFor(submission, verdict)), env, defer.ctx);
    await defer.settled();
    return response;
  }

  it("reports a message the check discarded, which reaches nothing else at all", async () => {
    const submission = await waitingFrom(analytics);

    const response = await check(submission, "discard");

    expect(response.status).toBe(200);
    expect(sent).toEqual([]);
    expect(events()).toHaveLength(1);
    expect(events()[0].event_type).toBe("contact_message_checked");
    expect(propertiesOf()[0]).toMatchObject({ source: "worker", outcome: "discarded", verdict: "discard" });
  });

  it("reports one that was delivered, so the two can be counted against each other", async () => {
    const submission = await waitingFrom(analytics);

    await check(submission, "deliver");

    expect(sent).toHaveLength(1);
    expect(propertiesOf()[0]).toMatchObject({ outcome: "delivered", verdict: "deliver" });
  });

  it("reports one the job could not reach a verdict on as delivered anyway", async () => {
    const submission = await waitingFrom(analytics);

    await check(submission, "undetermined");

    expect(propertiesOf()[0]).toMatchObject({ outcome: "delivered", verdict: "undetermined" });
  });

  it("files it against the visit that sent the message, minutes after it ended", async () => {
    const submission = await waitingFrom(analytics);

    await check(submission, "discard");

    expect(events()[0].device_id).toBe(analytics.deviceId);
    expect(events()[0].session_id).toBe(analytics.sessionId);
    expect(events()[0].user_id).toBe("visitor@example.com");
    expect(events()[0].event_properties).toMatchObject({ stitched: true });
  });

  it("says nothing about where the runner is, which is not where the visitor was", async () => {
    // The callback arrives from a GitHub Actions runner. Its address would put
    // the visitor in a datacentre, and its user agent would give them a device
    // they have never used.
    const submission = await waitingFrom(analytics);

    await check(submission, "discard");

    expect(events()[0].ip).toBe("0.0.0.0");
  });

  it("never sends a word of the message, nor the reason the model gave", async () => {
    const submission = await waitingFrom(analytics);

    await check(submission, "discard");

    const sentToAmplitude = JSON.stringify(uploaded);
    expect(sentToAmplitude).not.toContain("watches");
    expect(sentToAmplitude).not.toContain("A Visitor");
    expect(sentToAmplitude).not.toContain("advertising");
    expect(propertiesOf()[0].message_length).toBe("Buy cheap watches at example.com now".length);
  });

  it("still reports a submission stored before the ids were carried", async () => {
    const submission = await waitingFrom(undefined);

    await check(submission, "discard");

    expect(String(events()[0].device_id)).toMatch(/^worker-/);
    expect(events()[0].event_properties).toMatchObject({ stitched: false, outcome: "discarded" });
    // Named anyway: the address was proved at intake, whatever the browser did.
    expect(events()[0].user_id).toBe("visitor@example.com");
  });

  it("says nothing for a callback it refused", async () => {
    const submission = await waitingFrom(analytics);
    const request = await callback(verdictFor(submission, "discard"), { secret: "not-the-secret" });

    await handleContactChecked(request, measured(), defer.ctx);
    await defer.settled();

    expect(uploaded).toEqual([]);
  });

  it("says nothing twice for a callback that lands again", async () => {
    const submission = await waitingFrom(analytics);

    await check(submission, "discard");
    await check(submission, "discard");

    expect(events()).toHaveLength(1);
  });

  it("says nothing when the outcome could not be written down", async () => {
    const submission = await waitingFrom(analytics);
    storage.failPutsFor((key) => key.endsWith("submission.json"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await check(submission, "discard");

    expect(response.status).toBe(500);
    expect(uploaded).toEqual([]);
  });
});
