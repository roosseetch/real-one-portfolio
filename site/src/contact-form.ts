/**
 * The contact form, and everything that happens between a visitor pressing
 * Send and the page telling them what became of it.
 *
 * The page never learns whether a message was delivered. The Worker answers as
 * soon as it has accepted the submission and handed it to the checking job,
 * which runs for a minute or two afterwards, so "accepted" is the strongest
 * thing that can honestly be said here — and it is said that way.
 *
 * Nothing in this module reaches for a global. The endpoint, the site key, the
 * analytics sink and `fetch` all arrive as options, which is what lets the
 * tests drive a real form through every outcome without a network.
 */

import { forget, recall, remember } from "./verified-store";

/** Mirrors the Worker's own limits (worker/src/contact/intake.ts). Both sides check. */
export const LIMITS = {
  name: { min: 1, max: 100 },
  email: { min: 7, max: 64 },
  company: { min: 3, max: 64 },
  phone: { max: 24 },
  message: { min: 10, max: 300 },
} as const;

/** How many digits a phone number may hold. Fifteen is E.164's own ceiling. */
const PHONE_DIGITS = { min: 7, max: 15 } as const;

/** Digits in the code that is emailed. Fixed by the Worker, which mints them. */
const CODE_LENGTH = 6;

/**
 * How long to wait for Turnstile to hand over a second token.
 *
 * A token is spent by the address check, so sending the message needs another,
 * and the widget solves in the background. Five seconds is several times what a
 * managed challenge takes, and short enough that nobody is left watching a
 * disabled button wondering whether they pressed it.
 */
const TOKEN_WAIT_MS = 5_000;
const TOKEN_POLL_MS = 150;

/**
 * A phone number, checked by shape rather than by country.
 *
 * Deliberately forgiving about how it is written — `+44 20 7946 0958`,
 * `(020) 7946 0958` and `020-7946-0958` are all the same number to a person —
 * and strict only about there being a plausible count of digits in it. Guessing
 * at national formats would reject real numbers, and this field is optional:
 * refusing a message over it would cost more than it could ever save.
 */
export function isValidPhone(value: string): boolean {
  if (value.length > LIMITS.phone.max) return false;
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;

  const digits = value.replace(/\D/g, "").length;
  return digits >= PHONE_DIGITS.min && digits <= PHONE_DIGITS.max;
}

/**
 * The hidden input Turnstile writes its token into. Fixed by Turnstile, not by
 * us: the widget creates this field inside whatever form contains it.
 */
const TOKEN_FIELD = "cf-turnstile-response";

export interface ContactFormOptions {
  /**
   * Where a submission is POSTed. Null when this deployment has no Worker
   * configured, which is a form that could never deliver anything — so it is
   * not rendered at all.
   */
  endpoint: string | null;
  /** Turnstile site key. Null means the same as above: no form. */
  siteKey: string | null;
  /** Records an analytics event. A deployment without analytics passes a no-op. */
  track: (event: string, properties?: Record<string, unknown>) => void;
  /**
   * The Amplitude device and session this visit is using, sent with each request
   * so the Worker's own events join this visitor rather than a second one. Null
   * when there is no analytics to join, and the key is then left off the body.
   */
  identity?: () => { deviceId: string; sessionId: number | null } | null;
  /**
   * Attaches the address to this visitor, once the Worker has accepted a message
   * and so proved it. Optional for the same reason `track` is a no-op without a
   * key: a deployment without analytics has nobody to tell.
   */
  identify?: (email: string) => void;
  /** Injected so the tests can answer without a network. */
  fetch?: typeof fetch;
  /** Resets the challenge after a submission, so a second message can be sent. */
  resetChallenge?: () => void;
  /** How long to wait for the widget to produce a token. Shortened by the tests. */
  tokenWaitMs?: number;
}

type Outcome = "queued" | "code-sent" | "invalid" | "challenge" | "throttled" | "unavailable" | "network";

/**
 * What the visitor is told, per outcome.
 *
 * Kept away from the reason strings the Worker sends: those name an internal
 * decision, and a person reading them learns nothing they can act on.
 */
const MESSAGES: Record<Outcome, string> = {
  queued: "Thank you. Your message has been accepted and is on its way.",
  "code-sent": "Check your email for a six-digit code, type it below, and press Send again.",
  invalid: "That message could not be accepted. Please check the fields and try again.",
  challenge: "The anti-spam check did not pass. Please try the challenge again.",
  throttled: "That is a lot of messages at once. Please try again in a minute.",
  unavailable: "Messages cannot be accepted right now. Please try again later.",
  network: "Your message could not be sent. Please check your connection and try again.",
};

function field(
  form: HTMLFormElement,
  id: string,
  label: string,
  control: HTMLInputElement | HTMLTextAreaElement,
  { required = true, hidden = false }: { required?: boolean; hidden?: boolean } = {},
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "form-field";
  wrapper.hidden = hidden;

  const labelEl = document.createElement("label");
  labelEl.htmlFor = id;
  labelEl.textContent = label;

  // Only for a field the visitor can see and may skip. A hidden one is not
  // optional, it is not being asked for yet — and it is required the moment it
  // appears.
  if (!required && !hidden) {
    // Said in the label rather than left to the absence of an asterisk, which
    // only means something to somebody who has already noticed the asterisks.
    const hint = document.createElement("span");
    hint.className = "field-optional";
    hint.textContent = " (optional)";
    labelEl.append(hint);
  }

  control.id = id;
  control.name = id;
  control.required = required;

  wrapper.append(labelEl, control);
  form.append(wrapper);
  return wrapper;
}

/**
 * Renders the form into `section`, wired up.
 *
 * Returns nothing: everything a caller could want to do afterwards is done by
 * the form itself, and handing back a controller would only invite a second
 * place to submit from.
 */
export function renderContactForm(section: HTMLElement, options: ContactFormOptions): void {
  const { endpoint, siteKey } = options;

  const status = document.createElement("p");
  status.className = "form-status";
  // Announced when it changes rather than when it is read, so a visitor who
  // cannot see the form still learns what happened to their message.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  if (endpoint === null || siteKey === null) {
    // Not a failure to hide. A deployment that has not configured the Worker or
    // the challenge has no way to accept a message, and a form that silently
    // discards one is worse than no form.
    const notice = document.createElement("p");
    notice.className = "form-unavailable";
    notice.textContent = "The contact form is not configured for this deployment.";
    section.append(notice);
    return;
  }

  const form = document.createElement("form");
  form.className = "contact-form";
  // The Worker is on another origin, so a submission that ever fell through to
  // the browser's own handling would navigate away from the page. It never
  // should — the handler below always prevents it — but leaving the default
  // action unset means that a bug shows up as a form that does nothing rather
  // than as a visitor stranded on a JSON response.
  form.noValidate = false;

  const name = document.createElement("input");
  name.type = "text";
  name.autocomplete = "name";
  name.maxLength = LIMITS.name.max;

  const email = document.createElement("input");
  email.type = "email";
  email.autocomplete = "email";
  email.minLength = LIMITS.email.min;
  email.maxLength = LIMITS.email.max;

  const company = document.createElement("input");
  company.type = "text";
  company.autocomplete = "organization";
  // minLength is not a floor on an empty optional field: the browser applies it
  // only to a value somebody actually typed, which is exactly the rule wanted
  // here. The Worker checks it again for the case where nobody typed anything
  // in a browser at all.
  company.minLength = LIMITS.company.min;
  company.maxLength = LIMITS.company.max;

  const phone = document.createElement("input");
  phone.type = "tel";
  phone.autocomplete = "tel";
  phone.maxLength = LIMITS.phone.max;

  const message = document.createElement("textarea");
  message.rows = 6;
  message.minLength = LIMITS.message.min;
  message.maxLength = LIMITS.message.max;

  field(form, "name", "Your name", name);
  field(form, "email", "Your email", email);
  field(form, "company", "Your company", company, { required: false });
  field(form, "phone", "Your telephone", phone, { required: false });
  field(form, "message", "Your message", message);

  // Turnstile finds this by class once its script loads, renders the challenge
  // into it, and puts the token in a hidden input inside this form.
  const challenge = document.createElement("div");
  challenge.className = "cf-turnstile";
  challenge.dataset.sitekey = siteKey;
  form.append(challenge);

  // Hidden until a code has actually been sent. Rendered up front rather than
  // built on demand so that revealing it cannot fail halfway.
  const code = document.createElement("input");
  code.type = "text";
  code.inputMode = "numeric";
  code.autocomplete = "one-time-code";
  code.pattern = "\\d{6}";
  code.maxLength = CODE_LENGTH;

  const codeField = field(form, "code", "Code from your email", code, { required: false, hidden: true });

  const resend = document.createElement("button");
  resend.type = "button";
  resend.className = "link-button";
  resend.textContent = "Send a new code";
  resend.hidden = true;
  codeField.append(resend);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button primary";
  submit.textContent = "Send";
  form.append(submit);

  form.append(status);
  section.append(form);

  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const verifyEndpoint = `${endpoint}/verify`;

  /** The address a code was last sent to, so changing it starts again. */
  let awaitingCodeFor: string | null = null;
  /** The last token handed to the Worker. A token is single-use, so this one is finished. */
  let spentToken: string | null = null;

  function say(outcome: Outcome, text = MESSAGES[outcome]): void {
    status.textContent = text;
    status.classList.toggle("is-error", outcome !== "queued" && outcome !== "code-sent");
  }

  function showCodeField(show: boolean): void {
    codeField.hidden = !show;
    resend.hidden = !show;
    code.required = show;
    if (!show) code.value = "";
  }

  function currentToken(): string | null {
    const value = new FormData(form).get(TOKEN_FIELD);
    return typeof value === "string" && value !== "" ? value : null;
  }

  /**
   * A token nobody has spent, waiting for the widget when there is not one yet.
   *
   * The common case costs nothing: a challenge that solved while the visitor was
   * typing is read straight out of the form. The waiting is for the two moments
   * the widget is between tokens — just after a reset, and while an interactive
   * challenge is still being solved — where refusing immediately would be
   * telling somebody they failed a check that had not finished.
   *
   * If the wait runs out with only a spent token to hand, that is what gets
   * sent. The Worker gives a clear answer to it and the widget has reset by
   * then, so a second press works; refusing here would produce the same
   * sentence and nothing a second press could fix.
   */
  async function unspentToken(): Promise<string | null> {
    const current = currentToken();
    if (current !== null && current !== spentToken) return current;

    // Only when a spent one is sitting in the form. A widget that is already
    // mid-solve must not be knocked back to the start of it.
    if (current !== null) options.resetChallenge?.();

    const deadline = Date.now() + (options.tokenWaitMs ?? TOKEN_WAIT_MS);
    for (;;) {
      const value = currentToken();
      if (value !== null && value !== spentToken) return value;
      if (Date.now() >= deadline) return value;
      await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_MS));
    }
  }

  /**
   * The ids the Worker needs to file its own events under this visit rather than
   * under a visitor it invented.
   *
   * An absent key rather than a null one when there is no analytics to join, so
   * the Worker reads "the page did not say" rather than a value that means
   * nothing — the same rule the optional form fields follow.
   */
  function analyticsIds(): { analytics?: { deviceId: string; sessionId: number | null } } {
    const identity = options.identity?.() ?? null;
    return identity === null ? {} : { analytics: identity };
  }

  /**
   * Asks the Worker to email a code, and puts the form into the state where one
   * can be typed.
   *
   * Spends the token it is given, whatever the answer, and says so — a token is
   * single-use and the Worker has now seen this one.
   */
  async function requestCode(token: string): Promise<"code-sent" | "failed"> {
    status.textContent = "Checking your email address…";
    status.classList.remove("is-error");
    options.track("contact_verification_requested");

    let response: Response;
    try {
      spentToken = token;
      response = await send(verifyEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.value, turnstileToken: token, ...analyticsIds() }),
      });
    } catch {
      say("network");
      options.track("contact_form_rejected", { reason: "network" });
      return "failed";
    }

    if (!response.ok) {
      const outcome = outcomeOf(response.status);
      say(outcome);
      options.track("contact_form_rejected", { reason: outcome, status: response.status });
      // Fire and forget: the widget solves again in the background while the
      // visitor reads what went wrong.
      options.resetChallenge?.();
      return "failed";
    }

    awaitingCodeFor = email.value;
    showCodeField(true);
    code.focus();
    say("code-sent");
    options.track("contact_verification_sent");
    // Not awaited, and deliberately: the code field has to appear now, not in
    // however long the widget takes. Reading a code out of an inbox buys all
    // the time a new token needs.
    options.resetChallenge?.();
    return "code-sent";
  }

  resend.addEventListener("click", async () => {
    if (submit.disabled) return;
    if (!email.reportValidity()) return;

    submit.disabled = true;
    resend.disabled = true;

    const token = await unspentToken();
    if (token === null) {
      say("challenge");
    } else {
      // Deliberately the same path as the first request. A resend is not a
      // special case to the Worker: both codes stay valid, which is what
      // somebody who asked twice and then found the first mail actually needs.
      await requestCode(token);
    }

    resend.disabled = false;
    submit.disabled = false;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;

    // A number's shape is the one rule with no HTML attribute behind it, so it
    // is handed to the browser as a custom message and reported with the rest —
    // a visitor should not have to find out which of five fields is wrong from a
    // sentence at the bottom of the form.
    phone.setCustomValidity(phoneProblem(phone.value));

    // The browser's own validation first: it knows the field, and pointing at
    // the field beats a sentence at the bottom of the form.
    if (!form.reportValidity()) return;

    // Changing the address after a code was sent starts the proof again: the
    // code in the field belongs to an inbox this is no longer being sent from.
    if (awaitingCodeFor !== null && awaitingCodeFor !== email.value) {
      awaitingCodeFor = null;
      showCodeField(false);
    }

    submit.disabled = true;

    const token = await unspentToken();
    if (token === null) {
      say("challenge");
      options.track("contact_form_rejected", { reason: "challenge-incomplete" });
      submit.disabled = false;
      return;
    }

    // What this press offers as proof that the address is readable: the code
    // just typed, or the token an earlier verification left in this browser.
    let proof: { code: string } | { verificationToken: string };

    if (awaitingCodeFor !== null) {
      // Belt and braces: the code field is only required once it is visible, and
      // reportValidity ran before it was.
      if (!/^\d{6}$/.test(code.value.trim())) {
        say("invalid", "Enter the six-digit code from your email.");
        submit.disabled = false;
        return;
      }
      proof = { code: code.value.trim() };
    } else {
      const remembered = await recall(email.value);
      if (remembered === null) {
        // Never proved here, or the month has run out. Either way it starts with
        // a code, and this press ends by asking for one.
        await requestCode(token);
        submit.disabled = false;
        return;
      }
      options.track("contact_verification_skipped");
      proof = { verificationToken: remembered };
    }

    status.textContent = "Sending…";
    status.classList.remove("is-error");

    // Length rather than content: this is an analytics event, and what a
    // stranger wrote to her is not something to hand to a third party.
    options.track("contact_form_submitted", { message_length: message.value.length });

    // The optional fields are sent only when they were filled in, so an empty
    // one arrives as an absent key rather than as an empty string the Worker
    // would have to interpret.
    const body: Record<string, unknown> = {
      name: name.value,
      email: email.value,
      message: message.value,
      turnstileToken: token,
      ...analyticsIds(),
    };
    if (company.value.trim() !== "") body.company = company.value;
    if (phone.value.trim() !== "") body.phone = phone.value;
    Object.assign(body, proof);

    let response: Response;
    try {
      spentToken = token;
      response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      say("network");
      options.track("contact_form_rejected", { reason: "network" });
      submit.disabled = false;
      return;
    }

    const outcome = outcomeOf(response.status);
    const sentEmail = email.value;

    if (outcome === "queued") {
      // The Worker returns a token only when a code was just redeemed. Keeping
      // it is what spares this visitor the inbox next time.
      const answered = (await response.json().catch(() => null)) as { verificationToken?: unknown } | null;
      if (typeof answered?.verificationToken === "string") {
        await remember(sentEmail, answered.verificationToken);
      }

      // The Worker has just accepted this address as proved, which is the first
      // moment it is worth more than the visitor's word. Before the event, so
      // that one carries the id too, and everything the rest of the visit does.
      options.identify?.(sentEmail);

      say(outcome);
      options.track("contact_message_queued");
      form.reset();
      showCodeField(false);
      awaitingCodeFor = null;
    } else if (outcome === "challenge" && "verificationToken" in proof) {
      // The proof this browser was holding is no longer good: retired by a
      // verification somewhere else, or simply aged out. It is worth nothing
      // now, so it goes — and rather than leave the visitor to press Send again
      // and wonder, a code is asked for immediately.
      await forget(sentEmail);
      options.track("contact_form_rejected", { reason: "stale-verification" });

      const next = await unspentToken();
      if (next === null) say("challenge");
      else await requestCode(next);
    } else if (outcome === "challenge" && awaitingCodeFor !== null) {
      // The Worker answers 403 both for a challenge it did not believe and for a
      // code it did not accept. With a code in the request, the code is what it
      // was about — and saying "anti-spam check" there would send somebody to
      // fix the one thing that was fine.
      say("invalid", "That code is not right, or it has expired. Check your email, or ask for a new one.");
      options.track("contact_form_rejected", { reason: "code" });
    } else {
      say(outcome);
      options.track("contact_form_rejected", { reason: outcome, status: response.status });
    }

    // A spent challenge cannot be submitted twice, whatever the outcome was, so
    // the widget is reset either way — otherwise a visitor correcting a rejected
    // message would be refused a second time for a reason they cannot see.
    options.resetChallenge?.();
    submit.disabled = false;
  });
}

/** Empty is fine — the field is optional — and so is anything isValidPhone accepts. */
function phoneProblem(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || isValidPhone(trimmed)) return "";
  return `Enter a telephone number with ${PHONE_DIGITS.min} to ${PHONE_DIGITS.max} digits, or leave it empty.`;
}

function outcomeOf(status: number): Outcome {
  if (status === 202) return "queued";
  if (status === 403) return "challenge";
  if (status === 429) return "throttled";
  if (status === 400 || status === 413) return "invalid";
  return "unavailable";
}
