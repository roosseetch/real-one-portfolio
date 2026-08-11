/**
 * `POST /contact/verify`.
 *
 * This endpoint sends mail to an address a stranger chose, which makes the
 * refusals the point rather than the happy path: what must never happen is that
 * somebody without a solved challenge, or somebody asking over and over, gets
 * this Worker to deliver mail on their behalf.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { recordVerification } from "./codes";
import { parseCsv } from "./csv";
import { CODES_KEY } from "./records";
import { handleContactVerify } from "./verify";

const SITE = "https://site.example";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND = "https://api.resend.com/emails";

let storage: FakeBucket;
let outbound: string[];
/** Every body posted to Resend, so a test can read what would have been mailed. */
let mailed: Array<Record<string, unknown>>;
let challengePasses: boolean;
let resendStatus: number;

beforeEach(() => {
  storage = createFakeBucket();
  outbound = [];
  mailed = [];
  challengePasses = true;
  resendStatus = 200;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = String(url);
    outbound.push(target);

    if (target === SITEVERIFY) return new Response(JSON.stringify({ success: challengePasses }));

    mailed.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "mail-1" }), { status: resendStatus });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({
  PRIVATE_BUCKET: storage.bucket,
  SITE_BASE_URL: SITE,
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  RESEND_API_KEY: "resend-key",
  CONTACT_EMAIL_FROM: "Contact <no-reply@site.example>",
});

function post(body: unknown, { origin = SITE, address = "203.0.113.7" } = {}): Request {
  const headers = new Headers({ "content-type": "application/json", Origin: origin });
  if (address) headers.set("CF-Connecting-IP", address);
  return new Request("https://worker.example/contact/verify", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = { email: "visitor@example.com", turnstileToken: "solved-token" };

const mailsSent = () => outbound.filter((url) => url === RESEND);

describe("what reaches the handler at all", () => {
  it("answers a preflight for the site's own origin", async () => {
    const request = new Request("https://worker.example/contact/verify", {
      method: "OPTIONS",
      headers: { Origin: SITE },
    });
    const response = await handleContactVerify(request, env());

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
  });

  it("refuses another origin, and tells it nothing", async () => {
    const response = await handleContactVerify(post(VALID, { origin: "https://elsewhere.example" }), env());

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(outbound).toEqual([]);
  });

  it("refuses a method that is neither POST nor a preflight", async () => {
    const request = new Request("https://worker.example/contact/verify", {
      method: "GET",
      headers: { Origin: SITE },
    });

    expect((await handleContactVerify(request, env())).status).toBe(405);
  });

  const refused: Array<[string, unknown]> = [
    ["not JSON at all", "{"],
    ["a missing address", { turnstileToken: "solved-token" }],
    ["an address with no @", { ...VALID, email: "visitor.example.com" }],
    ["an address under the minimum", { ...VALID, email: "a@b.co" }],
    ["an address over the maximum", { ...VALID, email: `${"v".repeat(60)}@example.com` }],
    ["a missing token", { ...VALID, turnstileToken: "" }],
  ];

  for (const [what, body] of refused) {
    it(`refuses ${what}, without asking Turnstile`, async () => {
      const response = await handleContactVerify(post(body), env());

      expect(response.status).toBe(400);
      expect(outbound).toEqual([]);
    });
  }
});

describe("the challenge", () => {
  it("sends nothing when the token is not one Cloudflare recognises", async () => {
    challengePasses = false;

    const response = await handleContactVerify(post(VALID), env());

    expect(response.status).toBe(403);
    expect(mailsSent()).toEqual([]);
    expect(storage.objects.get(CODES_KEY)).toBeUndefined();
  });

  it("refuses everything, and blames nobody, when the secret is unset", async () => {
    const response = await handleContactVerify(post(VALID), { ...env(), TURNSTILE_SECRET_KEY: undefined });

    expect(response.status).toBe(503);
    expect(outbound).toEqual([]);
  });
});

describe("sending a code", () => {
  it("mails one, and says so without saying what it was", async () => {
    const response = await handleContactVerify(post(VALID), env());

    expect(response.status).toBe(200);
    const answered = (await response.json()) as { status: string };
    expect(answered.status).toBe("code-sent");

    expect(mailed).toHaveLength(1);
    expect(mailed[0].to).toEqual(["visitor@example.com"]);
    const code = parseCsv(storage.objects.get(CODES_KEY) ?? "")[0][1];
    expect(JSON.stringify(answered)).not.toContain(code);
  });

  it("puts the code in the mail, and the address in the file", async () => {
    await handleContactVerify(post(VALID), env());

    const [row] = parseCsv(storage.objects.get(CODES_KEY) ?? "");
    expect(row[0]).toBe("visitor@example.com");
    expect(String(mailed[0].text)).toContain(row[1]);
  });

  it("sends nothing at all to an address verified recently enough", async () => {
    await recordVerification(storage.bucket, "visitor@example.com");

    const response = await handleContactVerify(post(VALID), env());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "verified" });
    expect(mailsSent()).toEqual([]);
  });

  it("says it is unavailable, rather than that a code was sent, when the mail did not go", async () => {
    resendStatus = 422;

    const response = await handleContactVerify(post(VALID), env());

    expect(response.status).toBe(503);
  });

  it("says it is unavailable when no email is configured, and sends nothing", async () => {
    const response = await handleContactVerify(post(VALID), { ...env(), RESEND_API_KEY: undefined });

    expect(response.status).toBe(503);
    expect(mailsSent()).toEqual([]);
  });

  it("refuses once an address is holding too many live codes", async () => {
    for (let i = 0; i < 5; i++) {
      await handleContactVerify(post(VALID, { address: `203.0.113.${i}` }), env());
    }

    const response = await handleContactVerify(post(VALID, { address: "198.51.100.1" }), env());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ status: "refused", reason: "too-many-codes" });
  });
});

describe("throttling", () => {
  it("allows one request per address per minute", async () => {
    expect((await handleContactVerify(post(VALID), env())).status).toBe(200);

    const second = await handleContactVerify(post(VALID), env());

    expect(second.status).toBe(429);
    expect(mailsSent()).toHaveLength(1);
  });

  it("counts its own slot, not the one the message submission uses", async () => {
    // The two happen within the same minute as a matter of course: ask for a
    // code, then send the message it unlocked.
    const { claimSubmissionSlot } = await import("./throttle");
    await claimSubmissionSlot(storage.bucket, "203.0.113.7");

    expect((await handleContactVerify(post(VALID), env())).status).toBe(200);
  });

  it("never spends a mail on a request it is about to refuse", async () => {
    await handleContactVerify(post(VALID), env());
    const before = mailsSent().length;

    await handleContactVerify(post(VALID), env());

    expect(mailsSent()).toHaveLength(before);
  });
});
