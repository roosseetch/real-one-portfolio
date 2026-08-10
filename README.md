# Reusable Static Portfolio

A reusable, fully static personal portfolio system.

- **Site:** static HTML/CSS/TS (Vite), deployed to GitHub Pages. Page reads never touch a Worker, database, or runtime API.
- **Content:** immutable JSON chunks + manifest in a public Cloudflare R2 bucket; media in a separate public R2 bucket.
- **Authoring:** Telegram bot → Cloudflare Worker → Workers AI, with preview / edit / regenerate / cancel / publish in the same channel.
- **Media pipeline:** GitHub Actions sanitizes photos/videos (metadata scrub + configured decoy metadata) in ephemeral storage before anything becomes public. The sanitiser is a Rust binary in `sanitizer/`.
- **Infrastructure:** reusable Terraform (bootstrap + main stacks, R2 state backend).

No personal names, domains, account IDs, bucket names, or secrets appear in tracked files. All personalization comes from gitignored local files, GitHub variables/secrets, and Worker secrets. See `tasks/plan.md` for the implementation plan.

## Repository layout

```
site/            static portfolio site (Vite + vanilla TS)
profile/         approved public profile JSONs (facts, personality, design, portfolio)
worker/          Cloudflare Worker (Telegram webhook, drafts, AI, publishing)
sanitizer/       Rust media sanitiser: strips originals, injects the decoy
infrastructure/  Terraform: bootstrap/ (state bucket) and main/ (everything else)
scripts/         generate-wrangler, bootstrap-manifest, validate-profile
.github/         workflows + config-inventory.json (every variable and secret they use)
tasks/           implementation plan and task checklist
```

## Tests

```sh
npm ci && npm ci --prefix worker && npm ci --prefix site
npm test
```

That runs all three TypeScript suites: the profile validator (`scripts/`), the
Worker (`worker/src/`), and the site's Activity loader (`site/src/`). Each
package keeps its own `vitest.config.ts`, and needs one — with no config in its
directory vitest walks up and finds the repository root's, whose include pattern
covers `scripts/` only, so the suite silently reports no test files and passes.

The Worker and the site both import `profile/*.json`, which is not tracked (it
is one person's name and history). `npm test` copies `scripts/fixtures/valid/`
into `profile/` when nothing is there, and never overwrites, so a checkout that
has fetched the real profile keeps it. Run it on its own with `npm run
profile:test-fixture`. This is what keeps the pull-request gate hermetic: no
network, no variables, no secrets.

| Workflow | Trigger | What it runs |
| --- | --- | --- |
| `tests.yml` | pull request, push to main | typechecks + every vitest suite, on the fixture profile |
| `check-config.yml` | pull request, push to main | actionlint, the config inventory, the media workflow's steps, the security rules |
| `check-media.yml` | pull request, push to main | the sanitiser's Rust tests |
| `deploy-worker.yml` | push to main | typecheck + the Worker suite against the real profile, then deploys |

## Media sanitiser

`sanitizer/` holds the program that turns a draft's originals into public
derivatives. It removes metadata by re-encoding rather than by deleting tags —
a picture is decoded to pixels and written out again, a video is transcoded —
and only then injects the decoy values from `config/media-decoy.json`. It needs
`ffmpeg` (built with libx264) and nothing else at runtime.

Build and test it in a container, because it needs an ffmpeg with libx264 and
the tests additionally want exiftool, and few machines have both:

```sh
podman build -t media-sanitizer-dev sanitizer/
podman run --rm -v "$PWD":/repo:z -w /repo/sanitizer media-sanitizer-dev cargo test
```

exiftool is a test dependency only. The sanitiser writes its own EXIF, so the
suite checks those writes against an implementation that shares no code with it
— our own reader would happily agree with our own writer about a malformed
block.

`build-sanitizer.yml` compiles the binary on push to `main` and attaches it to a
`sanitizer-v<version>` release; `process-media.yml` fetches that exact version
rather than building, because that job runs while an author waits on a draft.
Bump `version` in `sanitizer/Cargo.toml` to cut a new one.

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

## Security and log hygiene

This repository is public, which makes every Actions log it produces public too.
Three rules follow from that, and `npm run security:check` enforces the
mechanical half of them on every pull request.

**Nothing that authenticates appears anywhere.** Every credential is a
repository secret, and GitHub masks those in logs. The Worker's own logs are
held to the same rule from the other side: `console.warn` and `console.error`
are captured into a durable object in the private bucket
(`worker/src/logging/error-log.ts`), so anything a call site prints is written
down and kept. The existing call sites print short literal messages, error text
and status codes — never the author's words, never a chat id, never a token.
`ai/generate.ts` goes further and removes the prompt from a model's error before
logging it, because the prompt is what the author typed. Anything added later
has to hold to that.

**Deployment identifiers do appear, and are not credentials.** The site's
domain, the bucket names derived from `PROJECT_SLUG`, the Cloudflare account and
zone ids, and the Amplitude browser key are repository *variables*, and GitHub
prints a job's environment block in the log. None of them grants access:
the R2 endpoint they compose refuses every unsigned request, and the Amplitude
key is inlined into the bundle every visitor downloads. Terraform still marks
the account and zone ids `sensitive` so they stay out of plan and state output,
where they would otherwise sit beside resource ids for ever.

**A pull request cannot reach a secret.** `check-config.yml`, `check-media.yml`
and `tests.yml` are credential-free by construction, so they run for forks.
`terraform-plan.yml` is the one exception: its `plan` job holds read-only
credentials and refuses to run for anything but a branch of this repository.
`pull_request_target` is not used anywhere, and the check refuses to let it be.

### The production environment

`deploy-worker.yml` and `terraform-apply.yml` both declare
`environment: production`. On this repository that environment requires a review
from its owner and restricts deployments to `main`, so every Worker deploy and
every infrastructure change waits for a person. `deploy-pages.yml` uses
`github-pages`, also restricted to `main`, with no reviewer: it publishes what
is already on `main` and changes nothing outside Pages.

A run waiting on the gate reports `status: waiting` rather than running, which
is why a Deploy Worker run can show an hour of "duration" and no failure:

```
gh api repos/<owner>/<repo>/actions/runs/<id>/pending_deployments
```

### Third-party actions

Pinned by commit — or, for a container action, by image digest — never by tag.
A tag is a name its owner can move, and these actions run on a runner holding
credentials for the private bucket and for Cloudflare. GitHub's own `actions/*`
stay on their major version, which is GitHub's documented advice and moves only
when GitHub moves it.

To bump one, resolve the new ref and update the trailing comment that names it:

```
gh api repos/<owner>/<repo>/commits/<tag> --jq .sha
```

Every `write` permission in `.github/workflows/` is listed with its reason in
`scripts/check-workflow-security.ts`; adding one anywhere fails the check until
it is written down there.

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
Once a direct request has been rejected the site stops retrying it for the rest
of the visit: the block will reject every later batch too, and one wasted
request per batch is worth avoiding.

Amplitude measures a session as the gap between its first and last event, so a
site that reports everything at load and nothing afterwards records every
visitor as a 0s session however long they stayed. `engagement.ts` therefore
sends up to four scroll-depth milestones and one `page_engaged` summary as the
visitor leaves, carrying the time the tab was actually on screen, how far down
they got, and which sections they saw. That last event is deliberately the only
end-of-visit signal: a periodic heartbeat would report the same thing but bill
the relay one Worker invocation per interval for every ad-blocked visitor. For
the same reason uploads are batched over ten seconds rather than the SDK's
default one, and the final one goes out through `sendBeacon`, which is the only
transport that survives the page being torn down.
