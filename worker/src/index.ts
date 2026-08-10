import { handleMediaFailed } from "./callbacks/media-failed";
import { handleMediaProcessed } from "./callbacks/media-processed";
import { handleAnalyticsProxy } from "./analytics/proxy";
import { sweepStrandedDrafts } from "./drafts/sweep";
import {
  beginRequest,
  beginScheduled,
  flush,
  installConsoleCapture,
  recordException,
  runWithLog,
  trackDeferred,
} from "./logging/error-log";
import { handleTelegramWebhook } from "./telegram/webhook";

export interface Env {
  // Bindings. The Worker still never writes media — GitHub Actions does, after
  // sanitizing it — but it does delete: a video declined at the confirmation
  // step was uploaded before anyone was asked about it, and the author has said
  // no to it. media/published.ts is the only thing that touches MEDIA_BUCKET,
  // and it only lists and deletes.
  PRIVATE_BUCKET: R2Bucket;
  CONTENT_BUCKET: R2Bucket;
  MEDIA_BUCKET: R2Bucket;
  AI: Ai;

  // Plain vars, generated into the Wrangler config at build time.
  CONTENT_BASE_URL: string;
  MEDIA_BASE_URL: string;
  SITE_BASE_URL: string;
  GITHUB_REPOSITORY: string;
  MEDIA_WORKFLOW_FILE: string;
  AMPLITUDE_API_KEY: string;

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

  if (request.method === "POST" && pathname === "/callbacks/media-failed") {
    return handleMediaFailed(request, env);
  }

  if ((request.method === "POST" || request.method === "OPTIONS") && pathname === "/analytics") {
    return handleAnalyticsProxy(request, env);
  }

  // Anything else is not part of the contract. Say nothing useful about what
  // the Worker is or which routes exist.
  return new Response("Not found", { status: 404 });
}

/**
 * The Worker handles authoring plus the site's analytics fallback relay. Site
 * content and media still come straight from public R2.
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

  /**
   * The cron trigger, whose only job is to notice drafts nothing came back for
   * (see drafts/sweep.ts). Its schedule lives in wrangler.template.json, beside
   * the handler rather than in Terraform, so deploying the Worker deploys the
   * timer that drives it.
   *
   * Logged like a request, because a scheduled failure has nobody watching it.
   * `500` is passed to flush on a throw for the same reason a 5xx is written
   * there: "it failed and said nothing" is the hardest case to reconstruct.
   *
   * The flush is awaited rather than deferred. `fetch` defers because it has a
   * response to hand back first; there is nothing to hand back here, and the
   * runtime keeps the invocation alive for as long as this promise runs.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const log = beginScheduled(controller.cron);

    await runWithLog(log, async () => {
      let status = 200;

      try {
        const swept = await sweepStrandedDrafts(env);
        // Only when it did something. A sweep that found nothing is the normal
        // case and runs every quarter of an hour; saying so would be noise, and
        // flush keeps nothing for a run that only ever succeeded.
        if (swept.stranded > 0) {
          console.error(`Swept ${swept.stranded} stranded draft(s) of ${swept.examined} examined`);
        }
      } catch (error) {
        // sweepStrandedDrafts swallows its own faults, so reaching here means
        // something outside it broke. Nothing retries a cron run, which is
        // precisely why it has to leave a trace.
        recordException(error);
        status = 500;
      }

      try {
        await flush(env.PRIVATE_BUCKET, log, status);
      } catch (error) {
        // `flush` swallows a failed write, so reaching here means the binding
        // itself is what broke and there is nowhere left to put the log.
        // Nothing retries a cron run, and rejecting would trade a readable line
        // in `wrangler tail` for the platform's own opaque error.
        console.error(`Could not write the scheduled run's log: ${(error as Error).message}`);
      }
    });
  },
} satisfies ExportedHandler<Env>;
