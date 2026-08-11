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
  email: { max: 254 },
  message: { min: 10, max: 2000 },
} as const;

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
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "form-field";

  const labelEl = document.createElement("label");
  labelEl.htmlFor = id;
  labelEl.textContent = label;

  control.id = id;
  control.name = id;
  control.required = true;

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
  email.maxLength = LIMITS.email.max;

  const message = document.createElement("textarea");
  message.rows = 6;
  message.minLength = LIMITS.message.min;
  message.maxLength = LIMITS.message.max;

  field(form, "name", "Your name", name);
  field(form, "email", "Your email", email);
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

    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.value,
          email: email.value,
          message: message.value,
          turnstileToken: token,
        }),
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

function outcomeOf(status: number): Outcome {
  if (status === 202) return "queued";
  if (status === 403) return "challenge";
  if (status === 429) return "throttled";
  if (status === 400 || status === 413) return "invalid";
  return "unavailable";
}
