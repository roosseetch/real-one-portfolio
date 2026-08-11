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
import { handleContactSubmission } from "./intake";

const SITE = "https://site.example";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

let storage: FakeBucket;
/** Every outbound request, so a test can assert what was never called at all. */
let outbound: string[];
let challengePasses: boolean;
let dispatchStatus: number;

beforeEach(() => {
  storage = createFakeBucket();
  outbound = [];
  challengePasses = true;
  dispatchStatus = 204;

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

const VALID = {
  name: "A Visitor",
  email: "visitor@example.com",
  message: "Hello, I would like to talk about a project.",
  turnstileToken: "solved-token",
};

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
    const response = await handleContactSubmission(post(VALID, { origin: "https://elsewhere.example" }), env());

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
      body: JSON.stringify(VALID),
    });

    expect((await handleContactSubmission(request, env())).status).toBe(413);
    expect(outbound).toEqual([]);
  });

  it("refuses a body that is over the ceiling despite what it declared", async () => {
    const response = await handleContactSubmission(
      post({ ...VALID, message: "x".repeat(20 * 1024) }),
      env(),
    );

    expect(response.status).toBe(413);
  });
});

describe("the fields", () => {
  const refused: Array<[string, unknown]> = [
    ["not JSON at all", "{"],
    ["a JSON array", []],
    ["a missing name", { ...VALID, name: undefined }],
    ["a name of spaces", { ...VALID, name: "   " }],
    ["an over-long name", { ...VALID, name: "n".repeat(101) }],
    ["an address with no @", { ...VALID, email: "visitor.example.com" }],
    ["an address with no dot in the domain", { ...VALID, email: "visitor@example" }],
    ["a message under the minimum", { ...VALID, message: "too short" }],
    ["a message over the maximum", { ...VALID, message: "m".repeat(2001) }],
    ["a missing token", { ...VALID, turnstileToken: "" }],
    ["an absurd token", { ...VALID, turnstileToken: "t".repeat(4096) }],
    ["a message that is only whitespace", { ...VALID, message: " ".repeat(50) }],
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
    await handleContactSubmission(post({ ...VALID, name: "  A Visitor  " }), env());

    const stored = JSON.parse(storage.objects.get(submissions()[0]) as string);
    expect(stored.message).toEqual({
      name: "A Visitor",
      email: "visitor@example.com",
      text: "Hello, I would like to talk about a project.",
    });
    expect(stored.state).toBe("checking");
    expect(stored.verdict).toBeNull();
  });
});

describe("the challenge", () => {
  it("refuses a token Cloudflare does not recognise", async () => {
    challengePasses = false;

    const response = await handleContactSubmission(post(VALID), env());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: "refused", reason: "challenge" });
    expect(submissions()).toEqual([]);
    expect(dispatched()).toEqual([]);
  });

  it("refuses everything, and blames nobody, when the secret is unset", async () => {
    const response = await handleContactSubmission(post(VALID), {
      ...env(),
      TURNSTILE_SECRET_KEY: undefined,
    });

    expect(response.status).toBe(503);
    expect(outbound).toEqual([]);
  });

  it("does not call a failed challenge a robot when Cloudflare is unreachable", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network"));

    const response = await handleContactSubmission(post(VALID), env());

    expect(response.status).toBe(503);
    expect(submissions()).toEqual([]);
  });

  it("passes the visitor's address to Turnstile", async () => {
    await handleContactSubmission(post(VALID), env());

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect((init?.body as FormData).get("remoteip")).toBe("203.0.113.7");
  });
});

describe("accepting", () => {
  it("stores the submission, dispatches the check, and says only that it is queued", async () => {
    const response = await handleContactSubmission(post(VALID), env());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "queued" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(submissions()).toHaveLength(1);
    expect(dispatched()).toEqual([
      "https://api.github.com/repos/owner/repo/actions/workflows/validate-contact.yml/dispatches",
    ]);
  });

  it("sends the job nothing but an id and a token", async () => {
    await handleContactSubmission(post(VALID), env());

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).includes("/dispatches"));
    const body = JSON.parse(String(call?.[1]?.body));
    expect(Object.keys(body.inputs).sort()).toEqual(["jobToken", "submissionId"]);
    expect(JSON.stringify(body)).not.toContain("visitor@example.com");
    expect(JSON.stringify(body)).not.toContain("project");
  });

  it("binds the dispatched token to the stored submission", async () => {
    await handleContactSubmission(post(VALID), env());

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url).includes("/dispatches"));
    const { inputs } = JSON.parse(String(call?.[1]?.body));
    const stored = JSON.parse(storage.objects.get(submissions()[0]) as string);

    expect(stored.submissionId).toBe(inputs.submissionId);
    expect(stored.jobToken).toBe(inputs.jobToken);
  });

  it("tells the visitor it failed when GitHub refuses the dispatch", async () => {
    dispatchStatus = 422;

    const response = await handleContactSubmission(post(VALID), env());

    expect(response.status).toBe(502);
  });

  it("stores nothing it cannot store", async () => {
    storage.failPutsFor((key) => key.endsWith("submission.json"));

    const response = await handleContactSubmission(post(VALID), env());

    expect(response.status).toBe(503);
    expect(dispatched()).toEqual([]);
  });
});

describe("throttling", () => {
  it("accepts one submission per address per minute", async () => {
    expect((await handleContactSubmission(post(VALID), env())).status).toBe(202);

    const second = await handleContactSubmission(post(VALID), env());

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ status: "refused", reason: "throttled" });
    expect(submissions()).toHaveLength(1);
  });

  it("refuses before spending an Actions run, which is what it is there to bound", async () => {
    await handleContactSubmission(post(VALID), env());
    outbound = [];

    await handleContactSubmission(post(VALID), env());

    expect(dispatched()).toEqual([]);
  });

  it("never charges a slot to a challenge that failed, so a retry is not refused", async () => {
    challengePasses = false;
    expect((await handleContactSubmission(post(VALID), env())).status).toBe(403);

    challengePasses = true;
    const retry = await handleContactSubmission(post(VALID), env());

    expect(retry.status).toBe(202);
  });

  it("counts addresses separately", async () => {
    await handleContactSubmission(post(VALID), env());

    const other = await handleContactSubmission(post(VALID, { address: "198.51.100.4" }), env());

    expect(other.status).toBe(202);
  });

  it("lets a request with no address through, so a local run is testable", async () => {
    const request = new Request(`${SITE}/contact`, {
      method: "POST",
      headers: { Origin: SITE, "content-type": "application/json" },
      body: JSON.stringify(VALID),
    });

    expect((await handleContactSubmission(request, env())).status).toBe(202);
  });

  it("never stores the address it throttled on", async () => {
    await handleContactSubmission(post(VALID), env());

    const everything = [...storage.objects.keys()].join(" ") + [...storage.objects.keys()].map((key) => storage.objects.get(key)).join(" ");
    expect(everything).not.toContain("203.0.113.7");
  });
});
