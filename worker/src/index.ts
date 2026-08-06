import { handleMediaProcessed } from "./callbacks/media-processed";
import {
  beginRequest,
  flush,
  installConsoleCapture,
  recordException,
  runWithLog,
  trackDeferred,
} from "./logging/error-log";
import { handleTelegramWebhook } from "./telegram/webhook";

export interface Env {
  // Bindings. There is deliberately no media bucket binding: the Worker never
  // writes media, GitHub Actions does, after sanitizing it.
  PRIVATE_BUCKET: R2Bucket;
  CONTENT_BUCKET: R2Bucket;
  AI: Ai;

  // Plain vars, generated into the Wrangler config at build time.
  CONTENT_BASE_URL: string;
  MEDIA_BASE_URL: string;
  SITE_BASE_URL: string;
  GITHUB_REPOSITORY: string;
  MEDIA_WORKFLOW_FILE: string;

  // Secrets, set with `wrangler secret put` and never in any config file.
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  GITHUB_DISPATCH_TOKEN: string;
  CALLBACK_HMAC_SECRET: string;
}

// Once per isolate, before any request can log anything.
installConsoleCapture();

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method === "POST" && pathname === "/telegram/webhook") {
    return handleTelegramWebhook(request, env, ctx);
  }

  if (request.method === "POST" && pathname === "/callbacks/media-processed") {
    return handleMediaProcessed(request, env);
  }

  // Anything else is not part of the contract. Say nothing useful about what
  // the Worker is or which routes exist.
  return new Response("Not found", { status: 404 });
}

/**
 * The Worker exists only for authoring. Visitors never reach it: the site
 * reads published JSON and media straight from public R2.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const log = beginRequest(request);

    return runWithLog(log, async () => {
      const deferred = trackDeferred(ctx);
      let response: Response;

      try {
        response = await route(request, env, deferred.context);
      } catch (error) {
        // Without this the platform answers with its own error page and the
        // reason dies with the isolate, which is the case worth having a log
        // for at all. Telegram sees a 500 and redelivers, which is right: an
        // unplanned throw is exactly the kind of fault a retry can survive.
        recordException(error);
        response = new Response("Internal error", { status: 500 });
      }

      ctx.waitUntil(deferred.settled().then(() => flush(env.PRIVATE_BUCKET, log, response.status)));
      return response;
    });
  },
} satisfies ExportedHandler<Env>;
