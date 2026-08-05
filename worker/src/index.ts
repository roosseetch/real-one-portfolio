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

/**
 * The Worker exists only for authoring. Visitors never reach it: the site
 * reads published JSON and media straight from public R2.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    if (request.method === "POST" && pathname === "/callbacks/media-processed") {
      return new Response("Media callback not implemented yet", { status: 501 });
    }

    // Anything else is not part of the contract. Say nothing useful about what
    // the Worker is or which routes exist.
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
