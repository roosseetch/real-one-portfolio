/**
 * Sending the verification code.
 *
 * A Worker cannot put mail on the wire by itself. Cloudflare's own send binding
 * only delivers to addresses the account has already verified, which is exactly
 * backwards for proving that a stranger owns theirs, so this goes through
 * Resend's HTTP API.
 *
 * Nothing here logs an address or a code. A verification mail is the one message
 * in this system whose contents are enough to impersonate somebody, and the
 * Worker's logs are read while debugging something else entirely.
 */

export interface ContactEmailEnv {
  RESEND_API_KEY: string | undefined;
  /** The From: address. A repository variable, because it is printed on every mail. */
  CONTACT_EMAIL_FROM: string | undefined;
  /** Named in the subject line, so the mail says which site it came from. */
  SITE_BASE_URL: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type SendOutcome = "sent" | "unconfigured" | "failed";

function siteName(env: ContactEmailEnv): string {
  try {
    return new URL(env.SITE_BASE_URL).hostname;
  } catch {
    return "this site";
  }
}

/**
 * The mail itself: plain text, short, and saying what to do with the code and
 * what to do if it was not asked for.
 *
 * No HTML part. There is nothing here that formatting would help with, and a
 * text-only mail cannot render a link that goes somewhere other than it says.
 */
export function verificationEmail(code: string, site: string, minutes: number): { subject: string; text: string } {
  return {
    subject: `Your ${site} contact code: ${code}`,
    text: [
      `Your verification code is ${code}.`,
      "",
      `It is valid for ${minutes} minutes. Type it into the contact form on ${site} to send your message.`,
      "",
      "If you did not ask to send a message, nobody can act on this and you can ignore it.",
    ].join("\n"),
  };
}

/**
 * Sends the code, and says only whether it went.
 *
 * `unconfigured` is kept apart from `failed` because they are different faults
 * with different owners: one is a deployment that has not been finished, the
 * other is a provider having a bad day, and a visitor should be told to try
 * later in both cases while the log distinguishes them.
 */
export async function sendVerificationCode(
  env: ContactEmailEnv,
  to: string,
  code: string,
  ttlMinutes: number,
): Promise<SendOutcome> {
  if (!env.RESEND_API_KEY || !env.CONTACT_EMAIL_FROM) {
    console.error("Cannot send a contact verification code: RESEND_API_KEY or CONTACT_EMAIL_FROM is unset");
    return "unconfigured";
  }

  const { subject, text } = verificationEmail(code, siteName(env), ttlMinutes);

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: env.CONTACT_EMAIL_FROM, to: [to], subject, text }),
    });
  } catch {
    console.error("Could not reach Resend to send a contact verification code");
    return "failed";
  }

  if (!response.ok) {
    // The status, and nothing from the body: Resend echoes the recipient back in
    // its error payloads, and this line goes to a log that outlives the request.
    console.error(`Resend refused a contact verification code (status ${response.status})`);
    return "failed";
  }

  return "sent";
}
