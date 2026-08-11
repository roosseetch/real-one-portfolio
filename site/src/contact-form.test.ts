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

import { isValidPhone, renderContactForm, type ContactFormOptions } from "./contact-form";
import { recall, remember } from "./verified-store";

const ENDPOINT = "https://worker.test/contact";
const VERIFY = `${ENDPOINT}/verify`;
const SITE_KEY = "0x-test-site-key";

const isVerifyCall = (url: unknown) => String(url) === VERIFY;

/**
 * What the Worker answers.
 *
 * Two endpoints now: the address check, then the message. Unless a test says
 * otherwise the address is already verified, so the flow runs straight through
 * and a test about what the Worker says to a *message* does not have to set up
 * a code first.
 */
const answering = (status: number, queued = '{"status":"queued"}') =>
  vi.fn(async (url: unknown, _init?: RequestInit) =>
    isVerifyCall(url)
      ? new Response('{"status":"code-sent"}', { status: 200 })
      : new Response(status === 202 ? queued : "", { status }),
  );

/** The message POST, whichever call it turned out to be. */
function messageCall(send: ReturnType<typeof answering>): [string, RequestInit] {
  const call = send.mock.calls.find(([url]) => !isVerifyCall(url));
  if (call === undefined) throw new Error("the message was never posted");
  return call as unknown as [string, RequestInit];
}

const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));

function mount(options: Partial<ContactFormOptions> = {}) {
  document.body.innerHTML = "";
  const section = document.createElement("section");
  document.body.append(section);

  const track = vi.fn();
  const send = options.fetch ?? answering(202);

  // Standing in for the widget rather than for a spy on it: a real reset
  // produces a *new* token, and the form waits for one before its second call.
  // A reset that left the old token in place would hang the form here and
  // nowhere else, which is the opposite of what the tests should model.
  let tokens = 0;
  const observed = options.resetChallenge;
  const resetChallenge = () => {
    observed?.();
    const input = section.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
    if (input !== null) input.value = `solved-token-${++tokens}`;
  };

  renderContactForm(section, {
    endpoint: ENDPOINT,
    siteKey: SITE_KEY,
    track,
    // The real wait is five seconds, for a widget that is mid-solve. Nothing
    // here is ever mid-solve: a token is either in the form or it is not.
    tokenWaitMs: 50,
    ...options,
    fetch: send as unknown as typeof fetch,
    resetChallenge,
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

const control = (form: HTMLFormElement, id: string) =>
  form.elements.namedItem(id) as HTMLInputElement | HTMLTextAreaElement;

function fill(form: HTMLFormElement, message = "Hello, I would like to get in touch about a project.") {
  control(form, "name").value = "A Visitor";
  control(form, "email").value = "visitor@example.com";
  control(form, "message").value = message;
}

/** What the form says while it is still working, and nothing has been decided. */
const IN_FLIGHT = ["Checking your email address…", "Sending…"];

/**
 * Submits and waits for the handler's own promise chain to settle.
 *
 * Both conditions are needed. The status alone would let a press through while
 * the form was between its two calls, and the button alone is momentarily
 * enabled before the handler has disabled it.
 */
async function submit(form: HTMLFormElement) {
  const section = form.parentElement as HTMLElement;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  await vi.waitFor(() => {
    expect(IN_FLIGHT).not.toContain(statusOf(section).textContent);
    expect(submitOf(section).disabled).toBe(false);
  });
}

/** The token a previous verification would have left in this browser. */
const KEPT_TOKEN = "0123456789abcdefghjkmnpqrstvwxyz";

/** Puts the browser in the state of somebody who has written before. */
const hasVerifiedBefore = (email = "visitor@example.com") => remember(email, KEPT_TOKEN);

beforeEach(async () => {
  // happy-dom has no layout, so reportValidity would be the only thing standing
  // between a filled-in form and the assertions. The fields are checked by the
  // Worker regardless, and one test below covers the browser's own refusal.
  HTMLFormElement.prototype.reportValidity = () => true;

  // The default is a returning visitor, because most of what is worth testing
  // here is what happens to a *message*. The suite that covers proving an
  // address clears this and starts from nothing.
  localStorage.clear();
  await hasVerifiedBefore();
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

    const [url, init] = messageCall(send);
    expect(url).toBe(ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      name: "A Visitor",
      email: "visitor@example.com",
      message: "Hello, I would like to get in touch about a project.",
      turnstileToken: "solved-token",
      verificationToken: KEPT_TOKEN,
    });
  });

  it("asks the verify endpoint nothing when this browser already holds a token", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(send.mock.calls.map(([url]) => String(url))).toEqual([ENDPOINT]);
    expect(bodyOf(messageCall(send)).verificationToken).toBe(KEPT_TOKEN);
    expect(bodyOf(messageCall(send)).code).toBeUndefined();
  });

  it("sends the optional fields when they were filled in", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    control(form, "company").value = "Acme Research";
    control(form, "phone").value = "+44 20 7946 0958";
    solveChallenge(form);

    await submit(form);

    expect(bodyOf(messageCall(send))).toMatchObject({
      company: "Acme Research",
      phone: "+44 20 7946 0958",
    });
  });

  it("leaves an untouched optional field out of the request entirely", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    // A field somebody tabbed through and typed a space in is an empty one.
    control(form, "company").value = "   ";
    solveChallenge(form);

    await submit(form);

    expect(Object.keys(bodyOf(messageCall(send))).sort()).toEqual([
      "email",
      "message",
      "name",
      "turnstileToken",
      "verificationToken",
    ]);
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
    const { section } = mount({ fetch: answering(400) as unknown as typeof fetch, resetChallenge });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    // The message spent a token, so the widget is reset on the way out — a
    // visitor correcting a rejected message must not be refused for a stale one.
    expect(resetChallenge).toHaveBeenCalledTimes(1);
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

describe("the fields", () => {
  it("marks the two optional ones as optional, and requires the rest", () => {
    const form = formOf(mount().section);

    expect(control(form, "company").required).toBe(false);
    expect(control(form, "phone").required).toBe(false);
    for (const id of ["name", "email", "message"]) {
      expect(control(form, id).required).toBe(true);
    }
    expect(form.querySelectorAll(".field-optional")).toHaveLength(2);
  });

  it("carries the limits the Worker enforces", () => {
    const form = formOf(mount().section);

    expect(control(form, "email").minLength).toBe(7);
    expect(control(form, "email").maxLength).toBe(64);
    expect(control(form, "company").minLength).toBe(3);
    expect(control(form, "company").maxLength).toBe(64);
    expect(control(form, "phone").maxLength).toBe(24);
    expect(control(form, "message").minLength).toBe(10);
    expect(control(form, "message").maxLength).toBe(300);
  });

  it("refuses a telephone number that is not one, before spending a request", async () => {
    // The real reportValidity, because a custom validity message is the whole
    // mechanism under test here.
    HTMLFormElement.prototype.reportValidity = function reportValidity(this: HTMLFormElement) {
      return this.checkValidity();
    };
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    control(form, "phone").value = "call me maybe";
    solveChallenge(form);

    await submit(form);

    expect(send).not.toHaveBeenCalled();
    expect(control(form, "phone").validationMessage).toContain("7 to 15 digits");
  });

  it("lets go of the telephone the moment it is emptied again", async () => {
    // The bug this pins bricked the form. `noValidate` is off, so the browser
    // validates before it dispatches `submit`: a custom error left on the field
    // meant the press that would have cleared it never reached the handler, and
    // nothing short of reloading the page could send the form again.
    const { section } = mount();
    const form = formOf(section);
    const phone = control(form, "phone");

    fill(form);
    phone.value = "telefone";
    phone.dispatchEvent(new Event("input", { bubbles: true }));
    expect(phone.validationMessage).toContain("7 to 15 digits");

    phone.value = "";
    phone.dispatchEvent(new Event("input", { bubbles: true }));

    expect(phone.validationMessage).toBe("");
    expect(phone.validity.customError).toBe(false);
    expect(form.checkValidity()).toBe(true);
  });

  it("refuses an address the Worker would refuse, rather than spending a request on it", async () => {
    // type="email" accepts name@example; the Worker wants a dot in the domain,
    // and answers 400 to what the browser was happy with.
    HTMLFormElement.prototype.reportValidity = function reportValidity(this: HTMLFormElement) {
      return this.checkValidity();
    };
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    const email = control(form, "email");

    fill(form);
    email.value = "ss.rustem@gmailcom";
    email.dispatchEvent(new Event("input", { bubbles: true }));
    solveChallenge(form);

    await submit(form);

    expect(send).not.toHaveBeenCalled();
    expect(email.validationMessage).toContain("name@example.com");
  });

  it("lets go of the address the moment it is corrected", async () => {
    const { section } = mount();
    const email = control(formOf(section), "email");

    email.value = "ss.rustem@gmailcom";
    email.dispatchEvent(new Event("input", { bubbles: true }));
    expect(email.validationMessage).not.toBe("");

    email.value = "ss.rustem@gmail.com";
    email.dispatchEvent(new Event("input", { bubbles: true }));

    expect(email.validationMessage).toBe("");
  });

  it("says nothing about an empty address, which is the required attribute's business", () => {
    const { section } = mount();
    const email = control(formOf(section), "email");

    email.value = "";
    email.dispatchEvent(new Event("input", { bubbles: true }));

    expect(email.validity.customError).toBe(false);
  });
});

describe("proving the address", () => {
  // A browser that has never done this before.
  beforeEach(() => localStorage.clear());

  /** The Worker's answer when it has just emailed a code. */
  const codeSent = () => answering(202);

  const codeInput = (section: HTMLElement) => control(formOf(section), "code") as HTMLInputElement;
  const codeFieldOf = (section: HTMLElement) =>
    codeInput(section).closest(".form-field") as HTMLElement;
  const resendOf = (section: HTMLElement) => section.querySelector(".link-button") as HTMLButtonElement;

  it("hides the code field until a code has actually been sent", () => {
    const { section } = mount();

    expect(codeFieldOf(section).hidden).toBe(true);
    expect(resendOf(section).hidden).toBe(true);
    expect(codeInput(section).required).toBe(false);
  });

  it("asks for the code, and posts no message, when one was emailed", async () => {
    const send = codeSent();
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(send.mock.calls.map(([url]) => String(url))).toEqual([VERIFY]);
    expect(codeFieldOf(section).hidden).toBe(false);
    expect(codeInput(section).required).toBe(true);
    expect(statusOf(section).textContent).toContain("six-digit code");
    expect(statusOf(section).classList.contains("is-error")).toBe(false);
  });

  it("sends the message with the code on the second press", async () => {
    const send = codeSent();
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);

    codeInput(section).value = "123456";
    await submit(form);

    expect(bodyOf(messageCall(send))).toMatchObject({ code: "123456" });
    expect(statusOf(section).textContent).toContain("accepted");
  });

  it("does not ask the Worker again once the address is proven", async () => {
    const send = codeSent();
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);
    codeInput(section).value = "123456";

    await submit(form);

    expect(send.mock.calls.filter(([url]) => isVerifyCall(url))).toHaveLength(1);
  });

  it("refuses to send with a code of the wrong shape, without spending a request", async () => {
    const send = codeSent();
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);
    codeInput(section).value = "12345";

    await submit(form);

    expect(send.mock.calls.filter(([url]) => !isVerifyCall(url))).toEqual([]);
    expect(statusOf(section).textContent).toContain("six-digit code");
    expect(statusOf(section).classList.contains("is-error")).toBe(true);
  });

  it("blames the code rather than the challenge when the Worker refuses one", async () => {
    // The Worker answers 403 for both, and with a code in the request it is the
    // code that was refused — sending somebody to redo the challenge would have
    // them fix the one thing that was fine.
    const send = vi.fn(async (url: unknown) =>
      isVerifyCall(url)
        ? new Response('{"status":"code-sent"}', { status: 200 })
        : new Response('{"status":"refused","reason":"unverified"}', { status: 403 }),
    );
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);
    codeInput(section).value = "123456";

    await submit(form);

    expect(statusOf(section).textContent).toContain("not right, or it has expired");
    expect(statusOf(section).textContent).not.toContain("anti-spam");
  });

  it("starts again when the address is changed after a code was sent", async () => {
    const send = codeSent();
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);
    codeInput(section).value = "123456";

    control(form, "email").value = "someone-else@example.com";
    await submit(form);

    // A second code request, for the new address, and the old code discarded.
    expect(send.mock.calls.filter(([url]) => isVerifyCall(url))).toHaveLength(2);
    expect(bodyOf(send.mock.calls[1] as unknown as [string, RequestInit]).email).toBe(
      "someone-else@example.com",
    );
    expect(codeInput(section).value).toBe("");
  });

  it("asks for another code without touching the message, and keeps the field showing", async () => {
    const send = codeSent();
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);

    resendOf(section).click();
    await vi.waitFor(() => expect(send.mock.calls).toHaveLength(2));

    expect(send.mock.calls.every(([url]) => isVerifyCall(url))).toBe(true);
    expect(codeFieldOf(section).hidden).toBe(false);
  });

  it("clears the code field once the message has gone", async () => {
    const send = codeSent();
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);
    codeInput(section).value = "123456";

    await submit(form);

    expect(codeFieldOf(section).hidden).toBe(true);
    expect(codeInput(section).value).toBe("");
  });

  it("says a code cannot be asked for again so soon, rather than asking for one to be typed", async () => {
    const send = vi.fn(async () => new Response('{"status":"refused","reason":"too-many-codes"}', { status: 429 }));
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(statusOf(section).textContent).toContain("try again in a minute");
    expect(codeFieldOf(section).hidden).toBe(true);
  });

  it("records the verification steps for analytics, with no address in them", async () => {
    const send = codeSent();
    const { section, track } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(track).toHaveBeenCalledWith("contact_verification_requested");
    expect(track).toHaveBeenCalledWith("contact_verification_sent");
    const properties = track.mock.calls.flatMap((call) => Object.values(call[1] ?? {}));
    expect(properties).not.toContain("visitor@example.com");
  });

  it("records that an address needed no code at all", async () => {
    await hasVerifiedBefore();
    const { section, track } = mount();
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(track).toHaveBeenCalledWith("contact_verification_skipped");
  });

  it("keeps the token the Worker hands back, so the next message needs no code", async () => {
    const send = answering(202, '{"status":"queued","verificationToken":"aaaa456789abcdefghjkmnpqrstvwxyz"}');
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);
    await submit(form);
    codeInput(section).value = "123456";

    await submit(form);

    expect(await recall("visitor@example.com")).toBe("aaaa456789abcdefghjkmnpqrstvwxyz");
  });

  it("forgets a token the Worker refuses, and asks for a code instead of leaving the visitor stuck", async () => {
    await hasVerifiedBefore();
    // A token retired by a verification somewhere else, or simply aged out.
    const send = vi.fn(async (url: unknown) =>
      isVerifyCall(url)
        ? new Response('{"status":"code-sent"}', { status: 200 })
        : new Response('{"status":"refused","reason":"unverified"}', { status: 403 }),
    );
    const { section, track } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(await recall("visitor@example.com")).toBeNull();
    expect(track).toHaveBeenCalledWith("contact_form_rejected", { reason: "stale-verification" });
    // And a code is already on its way, rather than a dead end.
    expect(send.mock.calls.filter(([url]) => isVerifyCall(url))).toHaveLength(1);
    expect(statusOf(section).textContent).toContain("six-digit code");
  });
});

describe("what counts as a telephone number", () => {
  const accepted = [
    "+44 20 7946 0958",
    "(020) 7946 0958",
    "020-7946-0958",
    "+1 555 019 9900",
    "5550199",
  ];
  for (const value of accepted) {
    it(`accepts ${value}`, () => expect(isValidPhone(value)).toBe(true));
  }

  const refused: Array<[string, string]> = [
    ["too few digits", "12345"],
    ["more digits than E.164 allows", "1234567890123456"],
    ["letters", "call me maybe"],
    ["an address wearing a plus", "+visitor@example.com"],
    ["longer than the field allows", `+${"1".repeat(30)}`],
    ["empty", ""],
  ];
  for (const [what, value] of refused) {
    it(`refuses ${what}`, () => expect(isValidPhone(value)).toBe(false));
  }
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

describe("telling the Worker who is here", () => {
  const IDENTITY = { deviceId: "0f2b1c3d-4e5f-6789-abcd-ef0123456789", sessionId: 1_754_900_000_000 };

  /** The request to /contact/verify, which is a different body from the message. */
  function verifyCall(send: ReturnType<typeof answering>): [string, RequestInit] {
    const call = send.mock.calls.find(([url]) => isVerifyCall(url));
    if (call === undefined) throw new Error("no code was ever asked for");
    return call as unknown as [string, RequestInit];
  }

  it("sends the visit's ids with the message, so the Worker's events join it", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch, identity: () => IDENTITY });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(bodyOf(messageCall(send)).analytics).toEqual(IDENTITY);
  });

  it("sends them when asking for a code too, which is the first thing it ever asks", async () => {
    localStorage.clear();
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch, identity: () => IDENTITY });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(bodyOf(verifyCall(send)).analytics).toEqual(IDENTITY);
  });

  it("leaves the key off entirely when there is no analytics to join", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch, identity: () => null });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(bodyOf(messageCall(send))).not.toHaveProperty("analytics");
  });

  it("sends nothing extra in a deployment that passes no identity at all", async () => {
    const send = answering(202);
    const { section } = mount({ fetch: send as unknown as typeof fetch });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(bodyOf(messageCall(send))).not.toHaveProperty("analytics");
  });

  it("stops being anonymous once the Worker has accepted the address", async () => {
    const identify = vi.fn();
    const { section } = mount({ fetch: answering(202) as unknown as typeof fetch, identify });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(identify).toHaveBeenCalledWith("visitor@example.com");
  });

  it("names the visitor before the event that says the message went, so that one carries it", async () => {
    const order: string[] = [];
    const { section } = mount({
      fetch: answering(202) as unknown as typeof fetch,
      identify: () => order.push("identify"),
      track: (event: string) => order.push(event),
    });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(order.indexOf("identify")).toBeLessThan(order.indexOf("contact_message_queued"));
  });

  it("names nobody when the Worker refused the message: the address is not proved", async () => {
    const identify = vi.fn();
    const { section } = mount({ fetch: answering(403) as unknown as typeof fetch, identify });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    await submit(form);

    expect(identify).not.toHaveBeenCalled();
  });

  it("names nobody when only a code has been asked for", async () => {
    localStorage.clear();
    const identify = vi.fn();
    const { section } = mount({ fetch: answering(202) as unknown as typeof fetch, identify });
    const form = formOf(section);
    fill(form);
    solveChallenge(form);

    // The first press ends with the code field showing; nothing has been proved.
    await submit(form);

    expect(identify).not.toHaveBeenCalled();
  });
});
