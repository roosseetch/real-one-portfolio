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
  /** Injected so the tests can answer without a network. */
  fetch?: typeof fetch;
  /** Resets the challenge after a submission, so a second message can be sent. */
  resetChallenge?: () => void;
}

type Outcome = "queued" | "invalid" | "challenge" | "throttled" | "unavailable" | "network";

/**
 * What the visitor is told, per outcome.
 *
 * Kept away from the reason strings the Worker sends: those name an internal
 * decision, and a person reading them learns nothing they can act on.
 */
const MESSAGES: Record<Outcome, string> = {
  queued: "Thank you. Your message has been accepted and is on its way.",
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
  { required = true }: { required?: boolean } = {},
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "form-field";

  const labelEl = document.createElement("label");
  labelEl.htmlFor = id;
  labelEl.textContent = label;

  if (!required) {
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

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button primary";
  submit.textContent = "Send";
  form.append(submit);

  form.append(status);
  section.append(form);

  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  function say(outcome: Outcome): void {
    status.textContent = MESSAGES[outcome];
    status.classList.toggle("is-error", outcome !== "queued");
  }

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

    const token = new FormData(form).get(TOKEN_FIELD);
    if (typeof token !== "string" || token === "") {
      say("challenge");
      options.track("contact_form_rejected", { reason: "challenge-incomplete" });
      return;
    }

    submit.disabled = true;
    status.textContent = "Sending…";
    status.classList.remove("is-error");

    // Length rather than content: this is an analytics event, and what a
    // stranger wrote to her is not something to hand to a third party.
    options.track("contact_form_submitted", { message_length: message.value.length });

    // The optional fields are sent only when they were filled in, so an empty
    // one arrives as an absent key rather than as an empty string the Worker
    // would have to interpret.
    const body: Record<string, string> = {
      name: name.value,
      email: email.value,
      message: message.value,
      turnstileToken: token,
    };
    if (company.value.trim() !== "") body.company = company.value;
    if (phone.value.trim() !== "") body.phone = phone.value;

    let response: Response;
    try {
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
    say(outcome);

    if (outcome === "queued") {
      options.track("contact_message_queued");
      form.reset();
    } else {
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
