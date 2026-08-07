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
.github/         workflows + config-inventory.json (every variable and secret they use)
tasks/           implementation plan and task checklist
```

## Repository variables and secrets

`.github/config-inventory.json` lists every repository variable and secret the
workflows may reference, what each is for, and — for the optional ones — what
happens when it is unset. `npm run config:check` holds that list and
`.github/workflows/` to each other, and CI runs it on every pull request.

It exists because GitHub resolves an unknown `secrets.NAME` or `vars.NAME` to an
empty string rather than failing. A renamed or mistyped name therefore ships a
workflow that runs, reports success, and does the wrong thing quietly. That has
already happened here: `secrets.GITHUB_DISPATCH_TOKEN`, a name GitHub refuses to
store because it reserves the `GITHUB_` prefix, deployed the Worker with a blank
token and turned every photo publication into "Publication failed" with no run
anywhere to look at.

Whether the declared names actually exist is a separate question and needs an
authenticated `gh`:

```
npm run config:check -- --live
```

`gh` runs in a container by default; `GH_CMD=gh npm run config:check -- --live`
uses a host installation instead.

### Read-only credentials for the plan job

`terraform-plan.yml` runs on pull requests, which means it is triggered by a
branch rather than by a merge. It must not hold a credential that could rewrite
state or change infrastructure, so it uses its own read-only pair. `terraform
plan` never persists state, so read access is enough. The job stops with a named
error until both exist.

**#TODO:** create these two, then add them as repository secrets:

1. **`CLOUDFLARE_API_TOKEN_PLAN`** — an API token at
   <https://dash.cloudflare.com/profile/api-tokens> with the same reach as
   `CLOUDFLARE_API_TOKEN` but **Read** instead of Edit throughout:

   ```
   Account | Workers R2 Storage      | Read
   Account | Workers Scripts         | Read
   Zone    | DNS                     | Read
   Zone    | Cache Rules             | Read
   Zone    | Workers Routes          | Read
   Zone    | Zone                    | Read
   Zone    | SSL and Certificates    | Read
   ```

2. **`R2_STATE_RO_ACCESS_KEY_ID`** and **`R2_STATE_RO_SECRET_ACCESS_KEY`** — from
   an R2 API token (R2 > API > Manage API tokens) with **Object Read-only**
   scoped to the state bucket alone. Cloudflare lets any R2 token act as an S3
   credential pair: the access key id is the token's own id, and the secret is
   the SHA-256 of the token value. `scripts/derive-r2-s3-credentials.sh` does
   that derivation for the token in `infrastructure/.env` — read it for the
   mechanics rather than running it here, since it overwrites the write
   credentials in that file.

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
