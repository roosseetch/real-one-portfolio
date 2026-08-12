/**
 * `GET /linkedin/callback` — where LinkedIn sends the browser after a login.
 *
 * This is the only route in the Worker a browser reaches without a secret, a
 * signature or a challenge, so everything it does hangs off the `state`: minted
 * by this Worker, handed out only inside an authorized Telegram chat, and spent
 * on first use. Without a live one, the page says the same thing it always says
 * and nothing happens.
 *
 * It answers with a page rather than a redirect. There is nowhere useful to send
 * a browser — the work continues in Telegram — and a redirect to the site would
 * carry LinkedIn's query string along with it.
 */
import { sendMessage } from "../telegram/api";
import { exchangeCode, fetchAuthorUrn, isConfigured } from "./oauth";
import { repostRecord, type RepostEnv } from "./repost";
import { takeState } from "./state";
import { saveToken, tokenFromGrant } from "./tokens";

export type ConnectEnv = RepostEnv;

/**
 * One page for every outcome, worded for the person holding the phone.
 *
 * Deliberately identical whether the state was good, stale, forged or absent.
 * Anyone can reach this URL, and telling them apart is telling a stranger which
 * of their guesses landed. What actually happened is reported in Telegram, where
 * only the author can read it.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>LinkedIn</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem}
  main{max-width:28rem;text-align:center}
</style></head>
<body><main>
<h1>All done here</h1>
<p>You can close this tab and go back to Telegram.</p>
</main></body></html>`;

function page(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The URL carries an authorization code. Nothing should keep it.
      "cache-control": "no-store",
      // The URL carries the code in its query string, and a referrer would hand
      // it to anything this page ever loaded. It loads nothing, but the header
      // costs nothing either.
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleLinkedInConnect(request: Request, env: ConnectEnv): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");

  // Nothing to spend, so nothing to do. This is also what a stranger poking the
  // route gets, and what a reload of a finished login gets.
  if (state === null) return page();

  const claimed = await takeState(env.PRIVATE_BUCKET, state);
  if (claimed === null) {
    console.warn("A LinkedIn callback arrived with no live state");
    return page();
  }

  // Past this point there is an author to talk to, so every outcome is reported
  // rather than only logged.
  const chatId = claimed.chatId;

  // LinkedIn reports a refusal here rather than by failing the redirect:
  // error=user_cancelled_login when the author changed their mind, and
  // error=unauthorized_scope_error when the app is missing a product.
  const error = params.get("error");
  if (error !== null) {
    console.warn(`LinkedIn declined the authorization: ${error}`);
    await sendMessage(env, chatId, "That LinkedIn login did not finish, so nothing was posted.");
    return page();
  }

  const code = params.get("code");
  if (code === null || !isConfigured(env)) {
    await sendMessage(env, chatId, "That LinkedIn login did not finish, so nothing was posted.");
    return page();
  }

  const granted = await exchangeCode(env, code);
  if (granted.status !== "granted") {
    await sendMessage(env, chatId, "LinkedIn would not issue a token for that login. Try the button again.");
    return page();
  }

  // The member's own URN, read once and stored beside the token: every post has
  // to name who authored it, and a login that cannot answer that is not usable.
  const authorUrn = await fetchAuthorUrn(granted.token.accessToken);
  if (authorUrn === null) {
    await sendMessage(env, chatId, "LinkedIn would not say who that account is. Try the button again.");
    return page();
  }

  try {
    await saveToken(env.PRIVATE_BUCKET, tokenFromGrant(granted.token, authorUrn));
  } catch (error) {
    // Without a stored token the next post asks for a login all over again, so
    // this has to be said out loud rather than swallowed.
    console.error(`Could not store the LinkedIn token: ${(error as Error).message}`);
    await sendMessage(env, chatId, "I could not save that LinkedIn login. Try the button again.");
    return page();
  }

  await sendMessage(env, chatId, "LinkedIn reconnected.");

  // The activity that was waiting when the token expired. Its exact text was
  // approved before the login, so finishing it is finishing what was started —
  // repostRecord reports the result, including its own failures.
  if (claimed.recordId !== null) {
    await repostRecord(env, chatId, claimed.recordId);
  }

  return page();
}
