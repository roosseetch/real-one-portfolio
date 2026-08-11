/**
 * The contact endpoint, which is the only route on this Worker that anyone can
 * reach.
 *
 * The tests are mostly about refusals, and about their order: a request that
 * fails the cheap checks must never reach Turnstile, and one that fails
 * Turnstile must never store an object or spend an Actions run. Those are the
 * properties that decide what a stranger can make this Worker do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { issueCode, recordVerification } from "./codes";
import { parseCsv } from "./csv";
import { handleContactSubmission } from "./intake";
import { MESSAGES_KEY } from "./records";

const SITE = "https://site.example";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

let storage: FakeBucket;
/** Every outbound request, so a test can assert what was never called at all. */
let outbound: string[];
let challengePasses: boolean;
let dispatchStatus: number;
/** The token the fixture address's verification handed out. */
let verifiedToken: string;

beforeEach(async () => {
  storage = createFakeBucket();
  outbound = [];
  challengePasses = true;
  dispatchStatus = 204;

  // The address every fixture submission uses, already proven, with the token
  // that proof handed out. Verification is a step of its own with its own suite
  // (verify.test.ts); what these tests are about is what happens to a message
  // once it is past that gate. The tests below that care about the gate itself
  // set up their own state.
  verifiedToken = await recordVerification(storage.bucket, "visitor@example.com");

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const target = String(url);
    outbound.push(target);

    if (target === SITEVERIFY) {
      return new Response(JSON.stringify({ success: challengePasses }));
    }
    // The workflow dispatch. 204 is GitHub's success.
    return new Response(null, { status: dispatchStatus });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({
  PRIVATE_BUCKET: storage.bucket,
  SITE_BASE_URL: SITE,
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  GITHUB_REPOSITORY: "owner/repo",
  CONTACT_WORKFLOW_FILE: "validate-contact.yml",
  GITHUB_DISPATCH_TOKEN: "dispatch-token",
});

/**
 * An ordinary submission from somebody who has written before: the fields, the
 * challenge, and the token their last verification left in their browser.
 *
 * A getter rather than a constant because the token is minted per test.
 */
const valid = () => ({
  name: "A Visitor",
  email: "visitor@example.com",
  message: "Hello, I would like to talk about a project.",
  turnstileToken: "solved-token",
  verificationToken: verifiedToken,
});

function post(body: unknown, { origin = SITE, address = "203.0.113.7" } = {}): Request {
  const headers = new Headers({ "content-type": "application/json", Origin: origin });
  if (address) headers.set("CF-Connecting-IP", address);
  return new Request(`${SITE.replace("site", "worker")}/contact`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const submissions = () => [...storage.objects.keys()].filter((key) => key.startsWith("contact/") && key.endsWith("submission.json"));

const dispatched = () => outbound.filter((url) => url.includes("/actions/workflows/"));

describe("what reaches the handler at all", () => {
  it("answers a preflight for the site's own origin", async () => {
    const request = new Request(`${SITE}/contact`, { method: "OPTIONS", headers: { Origin: SITE } });
    const response = await handleContactSubmission(request, env());

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
  });

  it("refuses another origin, and tells it nothing", async () => {
    const response = await handleContactSubmission(post(valid(), { origin: "https://elsewhere.example" }), env());

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(outbound).toEqual([]);
  });

  it("refuses a method that is neither POST nor a preflight", async () => {
    const request = new Request(`${SITE}/contact`, { method: "GET", headers: { Origin: SITE } });

    expect((await handleContactSubmission(request, env())).status).toBe(405);
  });

  it("refuses a body larger than the ceiling before reading it", async () => {
    const request = new Request(`${SITE}/contact`, {
      method: "POST",
      headers: { Origin: SITE, "content-length": String(64 * 1024) },
      body: JSON.stringify(valid()),
    });

    expect((await handleContactSubmission(request, env())).status).toBe(413);
    expect(outbound).toEqual([]);
  });

  it("refuses a body that is over the ceiling despite what it declared", async () => {
    const response = await handleContactSubmission(
      post({ ...valid(), message: "x".repeat(20 * 1024) }),
      env(),
    );

    expect(response.status).toBe(413);
  });
});

describe("the fields", () => {
  const refused: Array<[string, unknown]> = [
    ["not JSON at all", "{"],
    ["a JSON array", []],
    ["a missing name", { ...valid(), name: undefined }],
    ["a name of spaces", { ...valid(), name: "   " }],
    ["an over-long name", { ...valid(), name: "n".repeat(101) }],
    ["an address with no @", { ...valid(), email: "visitor.example.com" }],
    ["an address with no dot in the domain", { ...valid(), email: "visitor@example" }],
    ["a message under the minimum", { ...valid(), message: "too short" }],
    ["a message over the maximum", { ...valid(), message: "m".repeat(301) }],
    ["a missing token", { ...valid(), turnstileToken: "" }],
    ["an absurd token", { ...valid(), turnstileToken: "t".repeat(4096) }],
    ["a message that is only whitespace", { ...valid(), message: " ".repeat(50) }],
    ["an address under the minimum", { ...valid(), email: "a@b.co" }],
    ["an address over the maximum", { ...valid(), email: `${"v".repeat(60)}@example.com` }],
    ["a company under the minimum", { ...valid(), company: "Ax" }],
    ["a company over the maximum", { ...valid(), company: "c".repeat(65) }],
    ["a company that is not a string", { ...valid(), company: 42 }],
    ["a telephone number with too few digits", { ...valid(), phone: "12345" }],
    ["a telephone number with letters in it", { ...valid(), phone: "call me maybe" }],
    ["a telephone number longer than the field", { ...valid(), phone: `+${"1".repeat(30)}` }],
    ["a telephone number that is not a string", { ...valid(), phone: ["+44 20 7946 0958"] }],
  ];

  for (const [what, body] of refused) {
    it(`refuses ${what}, without asking Turnstile`, async () => {
      const response = await handleContactSubmission(post(body), env());

      expect(response.status).toBe(400);
      expect(outbound).toEqual([]);
      expect(submissions()).toEqual([]);
    });
  }

  it("stores what the visitor typed, trimmed and unmodified", async () => {
    await handleContactSubmission(post({ ...valid(), name: "  A Visitor  " }), env());

    const stored = JSON.parse(storage.objects.get(submissions()[0]) as string);
    expect(stored.message).toEqual({
      name: "A Visitor",
      email: "visitor@example.com",
      text: "Hello, I would like to talk about a project.",
    });
    expect(stored.state).toBe("checking");
    expect(stored.verdict).toBeNull();
  });

  it("accepts a submission with neither optional field", async () => {
    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(202);
    const stored = JSON.parse(storage.objects.get(submissions()[0]) as string);
    expect(stored.message.company).toBeUndefined();
    expect(stored.message.phone).toBeUndefined();
  });

  it("stores the optional fields when they were given", async () => {
    await handleContactSubmission(
      post({ ...valid(), company: "  Acme Research  ", phone: " +44 20 7946 0958 " }),
      env(),
    );

    const stored = JSON.parse(storage.objects.get(submissions()[0]) as string);
    expect(stored.message.company).toBe("Acme Research");
    expect(stored.message.phone).toBe("+44 20 7946 0958");
  });

  it("treats a blank optional field as one that was left out", async () => {
    await handleContactSubmission(post({ ...valid(), company: "   ", phone: "" }), env());

    const stored = JSON.parse(storage.objects.get(submissions()[0]) as string);
    expect("company" in stored.message).toBe(false);
    expect("phone" in stored.message).toBe(false);
  });

  const shapes = ["(020) 7946 0958", "020-7946-0958", "+1 555 019 9900", "5550199"];
  for (const phone of shapes) {
    it(`accepts a telephone number written as ${phone}`, async () => {
      const response = await handleContactSubmission(post({ ...valid(), phone }), env());

      expect(response.status).toBe(202);
    });
  }
});

describe("the challenge", () => {
  it("refuses a token Cloudflare does not recognise", async () => {
    challengePasses = false;

    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "refused", reason: "challenge" });
    expect(submissions()).toEqual([]);
    expect(dispatched()).toEqual([]);
  });

  it("refuses everything, and blames nobody, when the secret is unset", async () => {
    const response = await handleContactSubmission(post(valid()), {
      ...env(),
      TURNSTILE_SECRET_KEY: undefined,
    });

    expect(response.status).toBe(503);
    expect(outbound).toEqual([]);
  });

  it("does not call a failed challenge a robot when Cloudflare is unreachable", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network"));

    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(503);
    expect(submissions()).toEqual([]);
  });

  it("passes the visitor's address to Turnstile", async () => {
    await handleContactSubmission(post(valid()), env());

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect((init?.body as FormData).get("remoteip")).toBe("203.0.113.7");
  });
});

describe("accepting", () => {
  it("stores the submission, dispatches the check, and says only that it is queued", async () => {
    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "queued" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(submissions()).toHaveLength(1);
    expect(dispatched()).toEqual([
      "https://api.github.com/repos/owner/repo/actions/workflows/validate-contact.yml/dispatches",
    ]);
  });

  it("sends the job nothing but an id and a token", async () => {
    await handleContactSubmission(post(valid()), env());

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).includes("/dispatches"));
    const body = JSON.parse(String(call?.[1]?.body));
    expect(Object.keys(body.inputs).sort()).toEqual(["jobToken", "submissionId"]);
    expect(JSON.stringify(body)).not.toContain("visitor@example.com");
    expect(JSON.stringify(body)).not.toContain("project");
  });

  it("binds the dispatched token to the stored submission", async () => {
    await handleContactSubmission(post(valid()), env());

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).includes("/dispatches"));
    const { inputs } = JSON.parse(String(call?.[1]?.body));
    const stored = JSON.parse(storage.objects.get(submissions()[0]) as string);

    expect(stored.submissionId).toBe(inputs.submissionId);
    expect(stored.jobToken).toBe(inputs.jobToken);
  });

  it("tells the visitor it failed when GitHub refuses the dispatch", async () => {
    dispatchStatus = 422;

    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(502);
  });

  it("stores nothing it cannot store", async () => {
    storage.failPutsFor((key) => key.endsWith("submission.json"));

    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(503);
    expect(dispatched()).toEqual([]);
  });
});

describe("proving the address", () => {
  /** A submission from an address nobody has verified. */
  const stranger = () => ({ ...valid(), email: "stranger@example.com", verificationToken: undefined });

  it("refuses a message from an address that has proved nothing", async () => {
    const response = await handleContactSubmission(post(stranger()), env());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "refused", reason: "unverified" });
    expect(submissions()).toEqual([]);
    expect(dispatched()).toEqual([]);
  });

  it("accepts one carrying the code that was mailed", async () => {
    const issued = await issueCode(storage.bucket, "stranger@example.com");
    if (issued.status !== "issued") throw new Error("expected a code");

    const response = await handleContactSubmission(post({ ...stranger(), code: issued.code }), env());

    expect(response.status).toBe(202);
  });

  it("refuses one carrying a code that was never sent", async () => {
    await issueCode(storage.bucket, "stranger@example.com");

    const response = await handleContactSubmission(post({ ...stranger(), code: "000000" }), env());

    expect(response.status).toBe(403);
    expect(submissions()).toEqual([]);
  });

  it("refuses a code of the wrong shape without reading the file", async () => {
    const response = await handleContactSubmission(post({ ...stranger(), code: "12345" }), env());

    expect(response.status).toBe(400);
  });

  it("lets a browser holding the token through with no code at all", async () => {
    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(202);
  });

  it("refuses somebody who knows a verified address but holds no token", async () => {
    // The gap this closes. The address is in verified.csv and inside its
    // window; without the token that verification handed out, it proves that
    // somebody once read that inbox, not that this sender can.
    const response = await handleContactSubmission(
      post({ ...valid(), verificationToken: undefined }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "refused", reason: "unverified" });
    expect(submissions()).toEqual([]);
  });

  it("refuses a token that was never issued", async () => {
    const response = await handleContactSubmission(
      post({ ...valid(), verificationToken: "0123456789abcdefghjkmnpqrstvwxyz" }),
      env(),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a token of a shape it never mints, without reading the file", async () => {
    const response = await handleContactSubmission(
      post({ ...valid(), verificationToken: "../../etc/passwd" }),
      env(),
    );

    expect(response.status).toBe(400);
  });

  it("hands back a token when a code is redeemed, so the browser can keep it", async () => {
    const issued = await issueCode(storage.bucket, "stranger@example.com");
    if (issued.status !== "issued") throw new Error("expected a code");

    const response = await handleContactSubmission(post({ ...stranger(), code: issued.code }), env());
    const answered = (await response.json()) as { status: string; verificationToken?: string };

    expect(answered.status).toBe("queued");
    expect(answered.verificationToken).toMatch(/^[0-9a-z]{32}$/);

    // And it is the one that now works for that address.
    const next = await handleContactSubmission(
      post(
        { ...stranger(), verificationToken: answered.verificationToken },
        { address: "198.51.100.22" },
      ),
      env(),
    );
    expect(next.status).toBe(202);
  });

  it("does not repeat the token to a browser that already had it", async () => {
    const response = await handleContactSubmission(post(valid()), env());

    expect(await response.json()).toEqual({ status: "queued" });
  });

  it("says nothing about which of the three ways it was wrong", async () => {
    const never = await handleContactSubmission(post(stranger()), env());
    const wrong = await handleContactSubmission(
      post({ ...stranger(), code: "000000" }, { address: "198.51.100.9" }),
      env(),
    );

    expect(await never.json()).toEqual(await wrong.json());
  });
});

describe("the message record", () => {
  it("appends every field of the form, and when it was sent", async () => {
    await handleContactSubmission(
      post({ ...valid(), company: "Acme Research", phone: "+44 20 7946 0958" }),
      env(),
    );

    const [row] = parseCsv(storage.objects.get(MESSAGES_KEY) ?? "");
    expect(row.slice(0, 5)).toEqual([
      "A Visitor",
      "visitor@example.com",
      "Acme Research",
      "+44 20 7946 0958",
      "Hello, I would like to talk about a project.",
    ]);
    expect(Date.parse(row[5])).not.toBeNaN();
  });

  it("records nothing for a message it refused", async () => {
    challengePasses = false;

    await handleContactSubmission(post(valid()), env());

    expect(storage.objects.get(MESSAGES_KEY)).toBeUndefined();
  });

  it("still accepts the message when the record cannot be written", async () => {
    // The visitor's message is stored and dispatched by this point. Telling
    // them it failed would only have them send it again.
    storage.failPutsFor((key) => key === MESSAGES_KEY);

    const response = await handleContactSubmission(post(valid()), env());

    expect(response.status).toBe(202);
  });
});

describe("throttling", () => {
  it("accepts one submission per address per minute", async () => {
    expect((await handleContactSubmission(post(valid()), env())).status).toBe(202);

    const second = await handleContactSubmission(post(valid()), env());

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ status: "refused", reason: "throttled" });
    expect(submissions()).toHaveLength(1);
  });

  it("refuses before spending an Actions run, which is what it is there to bound", async () => {
    await handleContactSubmission(post(valid()), env());
    outbound = [];

    await handleContactSubmission(post(valid()), env());

    expect(dispatched()).toEqual([]);
  });

  it("never charges a slot to a challenge that failed, so a retry is not refused", async () => {
    challengePasses = false;
    expect((await handleContactSubmission(post(valid()), env())).status).toBe(403);

    challengePasses = true;
    const retry = await handleContactSubmission(post(valid()), env());

    expect(retry.status).toBe(202);
  });

  it("counts addresses separately", async () => {
    await handleContactSubmission(post(valid()), env());

    const other = await handleContactSubmission(post(valid(), { address: "198.51.100.4" }), env());

    expect(other.status).toBe(202);
  });

  it("lets a request with no address through, so a local run is testable", async () => {
    const request = new Request(`${SITE}/contact`, {
      method: "POST",
      headers: { Origin: SITE, "content-type": "application/json" },
      body: JSON.stringify(valid()),
    });

    expect((await handleContactSubmission(request, env())).status).toBe(202);
  });

  it("never stores the address it throttled on", async () => {
    await handleContactSubmission(post(valid()), env());

    const everything = [...storage.objects.keys()].join(" ") + [...storage.objects.keys()].map((key) => storage.objects.get(key)).join(" ");
    expect(everything).not.toContain("203.0.113.7");
  });
});
