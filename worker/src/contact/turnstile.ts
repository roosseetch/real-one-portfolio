/**
 * Cloudflare Turnstile, the challenge in front of the contact form.
 *
 * The token the browser sends is worth nothing until Cloudflare has been asked
 * about it: it is single-use, bound to the site key it was issued for, and
 * short-lived. Verifying is what makes it a check rather than a decoration —
 * a form that only rendered the widget would be posted to directly by anything
 * that can read HTML.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Turnstile's own tokens are a few hundred bytes; this is well past that and still a bound. */
export const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileEnv {
  // Declared as possibly undefined because a secret that was never set arrives
  // that way at runtime, whatever the Env interface claims.
  TURNSTILE_SECRET_KEY: string | undefined;
}

export type TurnstileResult = "passed" | "failed" | "unconfigured" | "unreachable";

/**
 * Asks Cloudflare whether this token is one it issued, and whether it has
 * already been spent.
 *
 * The four outcomes are kept apart because the caller answers them differently:
 * a failed challenge is the visitor's problem to retry, while an unconfigured
 * secret or an unreachable Cloudflare is ours and must not be reported as
 * "you are a robot".
 */
export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string,
  remoteIp: string | null,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET_KEY) {
    // Fail closed, and say so once: without the secret every submission is
    // refused, which is otherwise a mystifying blanket rejection.
    console.warn("TURNSTILE_SECRET_KEY is not configured; refusing every contact submission");
    return "unconfigured";
  }

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  // Optional, and Turnstile scores the token better with it. It is the address
  // the request arrived from and it goes no further than this call.
  if (remoteIp) body.append("remoteip", remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY, { method: "POST", body });
  } catch {
    console.warn("Turnstile siteverify could not be reached");
    return "unreachable";
  }

  if (!response.ok) {
    // Status only. Nothing from the body, which echoes the token back.
    console.warn(`Turnstile siteverify answered ${response.status}`);
    return "unreachable";
  }

  let outcome: { success?: unknown };
  try {
    outcome = (await response.json()) as { success?: unknown };
  } catch {
    console.warn("Turnstile siteverify returned something that is not JSON");
    return "unreachable";
  }

  return outcome.success === true ? "passed" : "failed";
}
