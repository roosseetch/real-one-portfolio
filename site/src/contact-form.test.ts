/**
 * The contact form's outcomes.
 *
 * Everything here goes through renderContactForm and a real <form>, because
 * what is worth testing is what a visitor is left looking at: a challenge that
 * was never solved has to stop the submission before it costs a request, and
 * every answer the Worker can give has to turn into a sentence rather than into
 * silence.
 *
 * No network and no widget: `fetch` is stubbed per test, and Turnstile's token
 * is the hidden input Turnstile itself would have added to the form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderContactForm, type ContactFormOptions } from "./contact-form";

const ENDPOINT = "https://worker.test/contact";
const SITE_KEY = "0x-test-site-key";

/** What the Worker answers, for a test that only cares about the status. */
const answering = (status: number) =>
  vi.fn(async () => new Response(status === 202 ? '{"status":"queued"}' : "", { status }));

function mount(options: Partial<ContactFormOptions> = {}) {
  document.body.innerHTML = "";
  const section = document.createElement("section");
  document.body.append(section);

  const track = vi.fn();
  const send = options.fetch ?? answering(202);

  renderContactForm(section, {
    endpoint: ENDPOINT,
    siteKey: SITE_KEY,
    track,
    fetch: send as unknown as typeof fetch,
    ...options,
  });

  return { section, track, send };
}

const formOf = (section: HTMLElement) => section.querySelector("form") as HTMLFormElement;
const statusOf = (section: HTMLElement) => section.querySelector(".form-status") as HTMLElement;
const submitOf = (section: HTMLElement) => section.querySelector("button[type=submit]") as HTMLButtonElement;

/** Stands in for the widget: the hidden field Turnstile writes its token into. */
function solveChallenge(form: HTMLFormElement, token = "solved-token") {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "cf-turnstile-response";
  input.value = token;
  form.append(input);
}

function fill(form: HTMLFormElement, message = "Hello, I would like to get in touch about a project.") {
  (form.elements.namedItem("name") as HTMLInputElement).value = "A Visitor";
  (form.elements.namedItem("email") as HTMLInputElement).value = "visitor@example.com";
  (form.elements.namedItem("message") as HTMLTextAreaElement).value = message;
}

/** Submits and waits for the handler's own promise chain to settle. */
async function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(statusOf(form.parentElement as HTMLElement).textContent).not.toBe("Sending…"));
}

beforeEach(() => {
  // happy-dom has no layout, so reportValidity would be the only thing standing
  // between a filled-in form and the assertions. The fields are checked by the
  // Worker regardless, and one test below covers the browser's own refusal.
  HTMLFormElement.prototype.reportValidity = () => true;
});

describe("configuration", () => {
  it("renders no form at all when the Worker endpoint is unset", () => {
    const { section } = mount({ endpoint: null });

    expect(formOf(section)).toBeNull();
    expect(section.querySelector(".form-unavailable")?.textContent).toContain("not configured");
  });

  it("renders no form at all when the site key is unset", () => {
    const { section } = mount({ siteKey: null });

    expect(formOf(section)).toBeNull();
  });

  it("hands the site key to the widget container", () => {
    const { section } = mount();

    expect(section.querySelector<HTMLElement>(".cf-turnstile")?.dataset.sitekey).toBe(SITE_KEY);
  });
});

describe("submitting", () => {
  it("posts the fields and the token to the Worker", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      name: "A Visitor",
      email: "visitor@example.com",
      message: "Hello, I would like to get in touch about a project.",
      turnstileToken: "solved-token",
    });
  });

  it("tells the visitor the message was accepted, and clears the form", async () => {
    const { section } = mount();
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(statusOf(section).textContent).toContain("accepted");
    expect(statusOf(section).classList.contains("is-error")).toBe(false);
    expect((form.elements.namedItem("message") as HTMLTextAreaElement).value).toBe("");
  });

  it("never asks the Worker anything until the challenge is solved", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);

    await submit(form);

    expect(send).not.toHaveBeenCalled();
    expect(statusOf(section).textContent).toContain("anti-spam check");
  });

  it("stops at the browser's own validation without spending a request", async () => {
    HTMLFormElement.prototype.reportValidity = () => false;
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    solveChallenge(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(send).not.toHaveBeenCalled();
  });

  it("resets the challenge whatever the outcome, so a second message can be sent", async () => {
    const resetChallenge = vi.fn();
    const { section } = mount({ fetch: answering(403) as unknown as typeof fetch, resetChallenge });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(resetChallenge).toHaveBeenCalledOnce();
  });

  it("re-enables the button after a refusal", async () => {
    const { section } = mount({ fetch: answering(400) as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(submitOf(section).disabled).toBe(false);
  });
});

describe("what the visitor is told", () => {
  const cases: Array<[number, string]> = [
    [400, "could not be accepted"],
    [403, "anti-spam check"],
    [429, "try again in a minute"],
    [503, "cannot be accepted right now"],
  ];

  for (const [status, expected] of cases) {
    it(`explains a ${status}`, async () => {
      const { section } = mount({ fetch: answering(status) as unknown as typeof fetch });
      const form = formOf(section);
      fill(form);
      solveChallenge(form);

      await submit(form);

      expect(statusOf(section).textContent).toContain(expected);
      expect(statusOf(section).classList.contains("is-error")).toBe(true);
    });
  }

  it("explains a request that never arrived", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { section } = mount({ fetch: offline as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(statusOf(section).textContent).toContain("check your connection");
  });
});

describe("analytics", () => {
  it("records the submission and the acceptance, with no message content", async () => {
    const { section, track } = mount();
    const form = formOf(section);
    fill(form, "A message exactly this long, and no shorter.");
    solveChallenge(form);

    await submit(form);

    expect(track).toHaveBeenCalledWith("contact_form_submitted", { message_length: 44 });
    expect(track).toHaveBeenCalledWith("contact_message_queued");

    const properties = track.mock.calls.flatMap((call) => Object.values(call[1] ?? {}));
    expect(properties).not.toContain("A message exactly this long, and no shorter.");
  });

  it("records why a submission was refused", async () => {
    const { section, track } = mount({ fetch: answering(429) as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(track).toHaveBeenCalledWith("contact_form_rejected", { reason: "throttled", status: 429 });
  });

  it("records a challenge that was never solved", async () => {
    const { section, track } = mount();
    fill(formOf(section));

    await submit(formOf(section));

    expect(track).toHaveBeenCalledWith("contact_form_rejected", { reason: "challenge-incomplete" });
  });
});
