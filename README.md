# Reusable Static Portfolio

A reusable, fully static personal portfolio system.

- **Site:** static HTML/CSS/TS (Vite), deployed to GitHub Pages. Page reads never touch a Worker, database, or runtime API.
- **Content:** immutable JSON chunks + manifest in a public Cloudflare R2 bucket; media in a separate public R2 bucket.
- **Authoring:** Telegram bot → Cloudflare Worker → Workers AI, with preview / edit / regenerate / cancel / publish in the same channel.
- **Media pipeline:** GitHub Actions sanitizes photos/videos (metadata scrub + configured decoy metadata) in ephemeral storage before anything becomes public.
- **Infrastructure:** reusable Terraform (bootstrap + main stacks, R2 state backend).

No personal names, domains, account IDs, bucket names, or secrets appear in tracked files. All personalization comes from gitignored local files, GitHub variables/secrets, and Worker secrets. See `tasks/plan.md` for the implementation plan.

## Repository layout

```
site/            static portfolio site (Vite + vanilla TS)
profile/         approved public profile JSONs (facts, personality, design, portfolio)
worker/          Cloudflare Worker (Telegram webhook, drafts, AI, publishing)
infrastructure/  Terraform: bootstrap/ (state bucket) and main/ (everything else)
scripts/         generate-wrangler, bootstrap-manifest, validate-profile
.github/         workflows: terraform-plan/apply, deploy-worker, process-media, deploy-pages
tasks/           implementation plan and task checklist
```

## Telegram webhook

The Worker accepts an update only if it carries the shared secret Telegram was
given at registration *and* comes from a user on the allowlist. Everything else
is dropped without a reply.

Set it up in this order — step 3 in particular is hard to undo out of sequence:

1. Create the bot with [BotFather](https://t.me/BotFather) and put the token in
   `worker/.dev.vars` as `TELEGRAM_BOT_TOKEN`.
2. `openssl rand -hex 32` → `TELEGRAM_WEBHOOK_SECRET`. Hex satisfies Telegram's
   charset for this field; a base64 secret does not.
3. Message the bot once, then read your own numeric ID from
   `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"` and put
   it in `TELEGRAM_ALLOWED_USER_IDS` (comma-separated for several people).
   **Do this before registering the webhook:** Telegram refuses `getUpdates`
   while a webhook is active, and the Worker never logs sender IDs, so afterwards
   you would have to delete the webhook to recover the value.
4. Put the Worker's public origin in `worker/.env` as `WORKER_BASE_URL`, then:

   ```
   set -a; . ./worker/.env; . ./worker/.dev.vars; set +a
   npm --prefix worker run webhook
   ```

   The script registers the webhook and prints what Telegram reports back,
   including the last delivery error — expected until the Worker is deployed.

To unregister: `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"`.

In production these values are Worker secrets (`wrangler secret put NAME`), set
by the deploy workflow from GitHub secrets. `worker/.dev.vars` is local only and
gitignored.

## Reading Worker errors

Log Explorer is a paid add-on and is deliberately not enabled, so the Worker
writes its own errors to the private bucket instead: one JSON object per failed
request under `logs/<day>/`, holding the request line, the status, and the
messages leading up to the failure. Warnings alone never produce an object —
otherwise anyone who found the webhook URL could fill the bucket with them.

```
npm run logs:read              # 10 most recent failures
npm run logs:read -- -n 40     # more of them
npm run logs:read -- -d 2026-08-06
```

It reads with the `R2_PRIVATE_RO` credentials from `infrastructure/.env`, so it
cannot change anything. A lifecycle rule expires the logs after
`error_log_retention_days` (14 by default). `wrangler tail` is still the better
tool while a problem is happening; this is for the ones that already happened.

## Analytics

Amplitude runs only when `AMPLITUDE_API_KEY` is set as a repository variable —
its browser ingestion key, not the Secret Key. It is a variable rather than a
secret because Vite inlines it into the bundle every visitor downloads.

With it unset, the init call is eliminated as dead code and the SDK never
reaches the bundle, so Amplitude simply shows nothing. The Pages workflow greps
the built assets and warns when that happens, because the two outcomes are
otherwise indistinguishable from the outside.

The SDK first uses Amplitude's normal ingestion endpoint directly. A configured
`AMPLITUDE_SERVER_URL` is used only when that browser request is rejected, as
can happen with a privacy extension or network block. Normal Amplitude HTTP
responses—including rate limits and server errors—do not use the Worker
fallback, so ordinary analytics traffic does not consume its request allowance.
