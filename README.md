# Reusable Static Portfolio

A reusable, fully static personal portfolio system.

- **Site:** static HTML/CSS/TS (Vite), deployed to GitHub Pages. Reading any page never touches a Worker, database, or runtime API. The contact page is the one place that calls out at all, and only once someone writes.
- **Content:** immutable JSON chunks + manifest in a public Cloudflare R2 bucket; media in a separate public R2 bucket.
- **Authoring:** Telegram bot → Cloudflare Worker → Workers AI, with preview / edit / regenerate / cancel / publish in the same channel.
- **Media pipeline:** GitHub Actions sanitizes photos/videos (metadata scrub + configured decoy metadata) in ephemeral storage before anything becomes public. The sanitiser is a Rust binary in `sanitizer/`.
- **Contact form:** its own static page at `/contact/`, behind a Cloudflare Turnstile challenge. A submission goes site → Worker → GitHub Actions, which screens it for spam before the Worker forwards it to the author's Telegram.
- **Infrastructure:** reusable Terraform (bootstrap + main stacks, R2 state backend).

No personal names, domains, account IDs, bucket names, or secrets appear in tracked files. All personalization comes from gitignored local files, GitHub variables/secrets, and Worker secrets.

The implementation plan — phases, task breakdown, acceptance criteria, risks — is on the [wiki](https://github.com/roosseetch/real-one-portfolio/wiki/Implementation-Plan). What is left to do, and what was done and when, is on the [project board](https://github.com/users/roosseetch/projects/2/views/1): that is the single record, and the repository deliberately keeps no second copy of it to drift out of date. Both links point at this deployment's own wiki and board, and are the two things a fork has to repoint.

## Repository layout

```
site/            static portfolio site (Vite + vanilla TS)
profile/         approved public profile JSONs (facts, personality, design, portfolio)
worker/          Cloudflare Worker (Telegram webhook, drafts, AI, publishing)
sanitizer/       Rust media sanitiser: strips originals, injects the decoy
infrastructure/  Terraform: bootstrap/ (state bucket) and main/ (everything else)
scripts/         generate-wrangler, bootstrap-manifest, validate-profile
.github/         workflows + config-inventory.json (every variable and secret they use)
```

## Contents

- [Deploying a new instance](#deploying-a-new-instance) — from an empty account to a live site
- [Publishing: the draft lifecycle](#publishing-the-draft-lifecycle) — what happens between a Telegram message and a record
- [The contact form](#the-contact-form) — what happens between a stranger writing and a message arriving
- [Backups and export](#backups-and-export) — what has a second copy and what does not
- [Tests](#tests) · [Media sanitiser](#media-sanitiser) · [Repository variables and secrets](#repository-variables-and-secrets)
- [Security and log hygiene](#security-and-log-hygiene) · [Telegram webhook](#telegram-webhook) · [Reading Worker errors](#reading-worker-errors) · [Analytics](#analytics)

## Deploying a new instance

Everything below is for someone deploying their own copy into their own
Cloudflare account and GitHub repository. It assumes only a Cloudflare account,
a GitHub account, a Telegram account, and `node` 24, `terraform` 1.13.3 and
`podman` (or `docker`) locally.

Three orderings are load-bearing, and each is called out again where it matters:

1. The **bootstrap stack** creates the bucket every other stack keeps its state
   in, so it runs first and keeps local state.
2. The **profile** is published to the content bucket before any build, because
   both the site build and the Worker deploy fetch it from there rather than
   from the repository.
3. The **Worker** is deployed by Wrangler before Terraform routes a hostname to
   it. A custom domain cannot bind to a script that does not exist.

Nothing here writes a deployment value into a tracked file. Every command that
needs one reads it from a gitignored `.env`, a gitignored `.auto.tfvars`, or a
repository variable.

### 1. Register the domain and find the two identifiers

Buying the domain through **Cloudflare Registrar** (Dashboard → Domain
Registration → Register Domains) is also how the zone gets created, which is
what the rest of this needs — Terraform writes records into a zone and cannot
create one. A domain registered elsewhere works just as well: add it under
**Add a site**, move the nameservers at the current registrar, and wait for the
zone to report **Active**.

From the zone's **Overview** page, copy the **Zone ID** and the **Account ID**
out of the right-hand column. Both are 32 hex characters. Neither is a
credential — they identify the deployment, they do not authenticate it — which
is why they end up as repository variables rather than secrets. Terraform still
marks them `sensitive` so they stay out of plan and state output.

### 2. Fill the local credential file

```sh
cp infrastructure/.env.example infrastructure/.env
```

Create the Cloudflare API token it asks for at
<https://dash.cloudflare.com/profile/api-tokens>, with the permissions listed
in the file:

```
Account | Workers R2 Storage      | Edit
Account | Workers Scripts         | Edit
Account | Turnstile               | Edit
Zone    | DNS                     | Edit
Zone    | Cache Rules             | Edit
Zone    | Workers Routes          | Edit
Zone    | Zone                    | Read
Zone    | SSL and Certificates    | Edit
```

The Terraform state backend speaks S3 rather than Cloudflare's API, so it needs
an access key pair as well. Cloudflare lets any R2-capable API token act as one
— the access key id is the token's own id, the secret is the SHA-256 of the
token value — and this derives it from the token you just created and writes it
back into the same file:

```sh
bash scripts/derive-r2-s3-credentials.sh
```

Fill your account id into the `AWS_ENDPOINT_URL_S3` line the example already
carries, and the file is complete. Nothing in it is ever committed, printed, or
passed on a command line.

### 3. Create the state bucket (bootstrap stack, once, by hand)

```sh
cp infrastructure/bootstrap/bootstrap.auto.tfvars.example \
   infrastructure/bootstrap/bootstrap.auto.tfvars
# fill in cloudflare_account_id

set -a; . ./infrastructure/.env; set +a
terraform -chdir=infrastructure/bootstrap init
terraform -chdir=infrastructure/bootstrap apply
```

This stack keeps **local** state, and no workflow runs it. It creates the bucket
the main stack's backend depends on, so it cannot keep its state there, and a
chicken-and-egg step is better run once by a person than automated into a loop.

One state bucket serves every project in an account; they are separated by key
prefix, not by bucket. If the account already has one from another project, set
`manage_state_bucket = false` and this stack uses it instead of failing to
create it twice.

Keep the `terraform.tfstate` it leaves behind — it is gitignored, and it is the
only record of that bucket being managed. See [Backups and
export](#backups-and-export).

### 4. Create the infrastructure (main stack)

```sh
cp infrastructure/main/backend.hcl.example infrastructure/main/backend.private.hcl
cp infrastructure/main/config.auto.tfvars.example infrastructure/main/config.auto.tfvars
```

In `backend.private.hcl`, set the bucket name from step 3, the endpoint for your
account, and a `key` beginning with your project slug — that prefix is what
keeps two projects from colliding on `production/terraform.tfstate`.

In `config.auto.tfvars`, set `cloudflare_account_id`, `cloudflare_zone_id`,
`project_slug` and `root_domain`. Leave `worker_enabled` at its default of
`false`; step 8 turns it on. Every other variable has a working default:
`content`, `media` and `worker` subdomains, the site on the apex, 7-day draft
retention, 14-day error-log retention.

```sh
set -a; . ./infrastructure/.env; set +a
terraform -chdir=infrastructure/main init -backend-config=backend.private.hcl
terraform -chdir=infrastructure/main apply
```

That creates three buckets — `<slug>-private`, `<slug>-content`,
`<slug>-media` — the lifecycle rules that expire drafts, originals, contact
messages and error logs, public custom domains for the content and media
buckets, the cache rules, the DNS records GitHub Pages needs, and the Turnstile
widget the contact form is challenged by.

Read the values the next steps need back out of it:

```sh
terraform -chdir=infrastructure/main output
terraform -chdir=infrastructure/main output -raw worker_hostname        # marked sensitive
terraform -chdir=infrastructure/main output -raw turnstile_secret_key   # marked sensitive
```

This first apply is the only one that has to happen locally. From here on
`terraform-apply.yml` owns the stack: it runs on every push to `main` touching
`infrastructure/**`, against the protected `production` environment.

> **Running Terraform in a container.** This repository's convention is to keep
> CLI tools off the host. The equivalent of the commands above is:
>
> ```sh
> podman run --rm -v "$PWD":/repo:z -w /repo/infrastructure/main \
>   -e CLOUDFLARE_API_TOKEN -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
>   -e AWS_ENDPOINT_URL_S3 -e AWS_REGION \
>   docker.io/hashicorp/terraform:1.13.3 apply
> ```
>
> Pass the credentials by name, as here, rather than expanding them into
> arguments: a `podman run -e KEY=value` puts the value in the host's process
> list.

### 5. Set the repository variables and secrets

`.github/config-inventory.json` is the authoritative list of what the workflows
may reference and what each name is for. This is where the values come from.

**Variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID from step 1 |
| `CLOUDFLARE_ZONE_ID` | Zone ID from step 1 |
| `PROJECT_SLUG` | the `project_slug` in `config.auto.tfvars`; every bucket name derives from it |
| `ROOT_DOMAIN` | the registered domain |
| `TF_STATE_BUCKET` | bootstrap's `state_bucket_name` output |
| `CONTENT_BASE_URL` | main stack's `content_base_url` output |
| `MEDIA_BASE_URL` | main stack's `media_base_url` output |
| `SITE_BASE_URL` | `https://` + the `site_hostname` output |
| `WORKER_BASE_URL` | `https://` + the `worker_hostname` output |
| `WORKER_NAME` | the Wrangler service name you choose; must match `worker_name` in the tfvars |
| `WORKER_ENABLED` | leave unset until step 8, then `true` |
| `SITE_SUBDOMAIN`, `PAGES_OWNER` | only when the site is not on the apex; set both together |
| `PAGES_BASE_PATH` | `/` when serving from a custom domain; unset means the `/<repo>/` project-pages subpath |
| `PAGES_CUSTOM_DOMAIN` | the site hostname, once step 9 has configured it |
| `AMPLITUDE_API_KEY`, `AMPLITUDE_SERVER_URL` | optional; see [Analytics](#analytics) |
| `TURNSTILE_SITE_KEY` | main stack's `turnstile_site_key` output. Optional, but without it `/contact/` renders a notice instead of a form |
| `MEDIA_WORKFLOW_FILE` | optional; defaults to `process-media.yml` |
| `CONTACT_WORKFLOW_FILE` | optional; defaults to `validate-contact.yml` |

**Secrets** (same page, Secrets tab):

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_API_TOKEN_PLAN` | a second token with the same reach but **Read** everywhere instead of Edit |
| `R2_STATE_RW_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | R2 → API → Manage API tokens: **Object Read & Write**, state bucket only |
| `R2_STATE_RO_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | the same, **Object Read-only** |
| `R2_PRIVATE_RO_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | **Object Read-only** on `<slug>-private` |
| `R2_MEDIA_RW_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | **Object Read & Write** on `<slug>-media` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS` | step 7 |
| `WORKER_DISPATCH_TOKEN` | a fine-grained GitHub token scoped to this repository alone, with **Actions: read and write**. It becomes the Worker's `GITHUB_DISPATCH_TOKEN` and is how a draft's media, and a contact message, reach their pipelines |
| `CALLBACK_HMAC_SECRET` | `openssl rand -hex 32`. Shared with the media and contact workflows, and the only reason the Worker believes a callback |
| `TURNSTILE_SECRET_KEY` | main stack's `turnstile_secret_key` output. The Worker verifies every contact submission's token against it |
| `WORKERS_AI_API_TOKEN` | a Cloudflare API token with **Account → Workers AI → Read** and nothing else. It runs the model that screens a contact message, and is deliberately not `CLOUDFLARE_API_TOKEN`, which can rewrite the buckets and the DNS |

Each R2 API token yields an S3 pair directly: Cloudflare shows the access key id
and the secret once, at creation. Scope each one to the buckets named above and
nothing else — the media pipeline reads originals with credentials that cannot
write, so a bug there cannot destroy the only copy of a photo, and writes
derivatives with credentials that cannot reach the manifest.

Two names in these tables deliberately differ from what they configure:
`WORKER_DISPATCH_TOKEN` becomes the Worker's `GITHUB_DISPATCH_TOKEN`, and
`PAGES_OWNER` fills Terraform's `github_pages_owner`. GitHub reserves the
`GITHUB_` prefix and refuses to store any secret or variable using it, so the
obvious names could never have held a value. Use the names exactly as written:
a name GitHub does not know resolves to an empty string rather than an error,
which is [its own kind of
outage](#repository-variables-and-secrets).

Confirm every declared name actually exists before running anything:

```sh
npm run config:check -- --live
```

### 6. Publish the profile and bootstrap the manifest

The profile is four JSON files describing one person. It is not tracked, because
this repository is meant to be reused: it lives in the gitignored
`private-inputs/profile/` and is published to the content bucket, from where
every build fetches it.

Write `facts.json`, `personality.json`, `design.json` and `portfolio.json` into
`private-inputs/profile/`. `profile/schemas/*.json` define the shape,
`scripts/fixtures/valid/` is a complete working example to start from, and
`FABLE_PROMPT.txt` is the prompt that turns them into the site's markup and
styling. Then:

```sh
npm run validate:profile -- private-inputs/profile
```

That checks them against the schemas and rejects deployment-specific values —
absolute URLs, domains, account or chat ids, e-mail addresses — because none of
that belongs in profile content.

Copy `worker/.env.example` to `worker/.env` and fill in the bucket names and
public URLs from step 4 (this file drives the scripts, and step 8's Wrangler
configuration), then publish:

```sh
set -a; . ./infrastructure/.env; . ./worker/.env; set +a
npm run profile:publish
npm --prefix worker run bootstrap:manifest
```

`profile:publish` drops the authoring-only fields — provisional
characterisation nobody confirmed — and uploads the rest to
`<content bucket>/profile/`. `bootstrap:manifest` writes the empty
`content/manifest.json` that publication needs. Publication refuses to create
that itself on purpose: a Worker pointed at the wrong bucket would otherwise
quietly start a second, empty history instead of failing where someone notices.
Running it twice is safe.

**Profile photos** are not published by the Telegram pipeline, which handles
activity media only. Sanitise them with the same binary the pipeline uses and
upload the results under the `media/profile/` prefix. Write a mapping from the
`mediaReferences` ids in `facts.json` to the files they came from:

```json
{ "hero": { "file": "portrait.jpeg", "type": "image" } }
```

The sanitiser names each derivative `<id>-<width>.webp`, which is exactly what
the site asks for; the widths it expects per reference are listed in
`site/src/sections.ts`, and no width above the source's is ever produced,
because nothing is upscaled.

```sh
podman build -t media-sanitizer-dev sanitizer/
podman run --rm -v "$PWD":/repo:z -w /repo media-sanitizer-dev \
  cargo run --manifest-path sanitizer/Cargo.toml -- \
  <source-dir> <work-dir> <mapping.json> --widths 1600,800
CLOUDFLARE_API_TOKEN=... python3 scripts/upload-media.py <work-dir> <media-bucket> media/profile
```

Run it from the repository root, as here: the decoy values it injects default to
`config/media-decoy.json` relative to the working directory. The upload step
re-checks each file with exiftool — the one command in this list that wants a
host tool — and refuses anything still carrying identifying metadata, so a
failed sanitisation cannot become a public object.

### 7. Create the Telegram bot

Follow [Telegram webhook](#telegram-webhook) for the bot token, the webhook
secret and the allowlist, and mind the ordering trap in that section: read your
numeric user id **before** registering the webhook, because Telegram refuses
`getUpdates` while one is active and the Worker never logs sender ids.

Register the webhook itself in step 8, once the Worker has a hostname.

### 8. Deploy the Worker, then route the hostname to it

Push the repository to GitHub and run the deploy:

```sh
gh workflow run deploy-worker.yml --ref main
```

It builds the Wrangler configuration from the repository variables, typechecks,
runs the Worker suite against the real profile, deploys, and then syncs the
Worker's secrets — after the deploy, because secrets attach to a script that
already exists. On a first deploy that leaves a brief window where the Worker
rejects every request for want of a webhook secret, which is the safe direction
to fail.

The run waits at the `production` gate if you created it in step 10.

Now let Terraform attach the custom domain, which it could not do while the
script did not exist:

1. set `WORKER_ENABLED` to `true` and confirm `WORKER_NAME`,
2. set `worker_enabled = true` and `worker_name` in `config.auto.tfvars`,
3. push, or run `gh workflow run terraform-apply.yml --ref main`.

Then register the webhook with `WORKER_BASE_URL` pointing at that hostname, as
[Telegram webhook](#telegram-webhook) describes. Wrangler is told not to attach
a `workers.dev` hostname — registering one would publish the webhook at a
second, unmanaged URL — so this custom domain is the only way in.

### 9. Turn on GitHub Pages

In Settings → Pages:

1. **Source: GitHub Actions.**
2. **Custom domain:** the site hostname. Terraform has already created the DNS
   for it — A and AAAA records at the apex, or a CNAME to `<owner>.github.io`
   for a subdomain — and left them **DNS-only rather than proxied**, because
   GitHub issues and renews the certificate itself and can only do that when it
   sees the real origin.
3. Tick **Enforce HTTPS** once the certificate has been issued.

Then set the `PAGES_CUSTOM_DOMAIN` variable to the same hostname and
`PAGES_BASE_PATH` to `/`, and deploy:

```sh
gh workflow run deploy-pages.yml --ref main
```

`PAGES_CUSTOM_DOMAIN` writes a `CNAME` file into the artifact on every deploy
because Pages otherwise drops the custom domain on some of them.

### 10. Protect the production environment

Create an environment named `production` (Settings → Environments), add
yourself as a required reviewer, and limit deployments to `main`.
`deploy-worker.yml` and `terraform-apply.yml` both target it, so with it in
place every Worker deploy and every infrastructure change waits for a person.
Without it, both deploy unreviewed. `github-pages` is created by GitHub itself
and needs no reviewer: it publishes what is already on `main`.

### 11. Verify

```sh
npm ci && npm ci --prefix worker && npm ci --prefix site
npm test
npm run config:check -- --live
```

Then, in order of how much they prove:

- the site loads on the custom domain, and its network tab shows requests to
  Pages, `content.<domain>` and `media.<domain>` and nothing else — on
  `/contact/`, add `challenges.cloudflare.com` for the Turnstile widget;
- a message to the bot comes back as a preview within a few seconds;
- **Publish** puts the record on the site after a reload;
- a photo published the same way, run through `exiftool`, carries the decoy
  make, model and GPS from `config/media-decoy.json` and nothing of the
  original;
- `/contact/` shows a form rather than a notice, and a message sent through it
  arrives in Telegram a minute or two later, with a `Validate contact message`
  run behind it.

## Publishing: the draft lifecycle

An author messages the bot; everything else follows from that message.

The Worker verifies the shared secret and the sender allowlist, stores a draft
at `drafts/<draft-id>/draft.json` in the private bucket and any files that came
with it under `originals/<activity-id>/`, asks Workers AI for a record — title,
summary, body, date, tags, per-item alt text and captions — and replies with a
preview and five buttons: **Publish**, **Edit text**, **Change media**,
**Regenerate**, **Cancel**.

The two identifiers are separate on purpose. A draft is private and an
activity's media is not, so one name spanning both would put the private
object's name in a public URL.

The states behind those buttons (`worker/src/drafts/state.ts` holds the table,
and rejects any move that is not in it):

| Flow | States |
| --- | --- |
| text only | `draft` → `awaiting_approval` → `published` |
| with media | `draft` → `awaiting_approval` → `processing` → `published` |
| video the transcode changed visibly | `draft` → `awaiting_approval` → `processing` → `awaiting_approval` → `published` |
| failure and retry | `processing` → `failed` → `processing` |

`published` and `cancelled` are terminal. Enforcing the table centrally is what
stops a late callback or a double-tapped button from moving a published draft
back into processing, or from publishing something already cancelled.

**Processing** means GitHub Actions. Approving a draft with media dispatches
`process-media.yml` with a draft id and a job token and nothing else — workflow
inputs are visible in the Actions UI, so anything passed there is effectively
public. The runner reads the originals with read-only credentials, re-encodes
them to strip metadata, injects the decoy, uploads the derivatives to the media
bucket, and posts an HMAC-signed callback the Worker checks before believing a
word of it.

**The third flow is the confirmation gate.** A clip the transcode visibly
changed goes back for a final look rather than being published behind the
author's back. It is a second pass through `awaiting_approval`, not a state of
its own; what tells the two apart is that the sanitised media already exists,
so publishing then uses those exact files instead of asking for the work again.
That second look offers **Publish** and **Cancel** only — the text was approved
on the first pass, and the media is now a finished file in the public bucket.

**Failures reach the author.** A run that fails or is cancelled posts to
`/callbacks/media-failed`, and the draft moves to `failed` with **Retry** and
**Cancel** offered. Retry reuses the same draft and activity id with a fresh job
token and republishes from the already-uploaded files rather than sanitising
twice.

A run that never reports at all — a dead runner, a dispatch GitHub accepted and
never scheduled — leaves nothing to send that callback. A cron every fifteen
minutes sweeps drafts stuck in `processing` for more than thirty minutes and
fails them the same way, so the author hears within three quarters of an hour
instead of never. The threshold is generous on purpose: being slow costs a later
message, being wrong tells someone their post failed while it is still
publishing.

**Publication is append-only.** A record joins a chunk of ten; the chunk is
written under a new id and the manifest repointed, so chunks are immutable and
cacheable for a year while the manifest is never served unchecked. Nothing is
ever edited in place, which is also why removing a record is a rewrite:

```sh
set -a; . ./infrastructure/.env; . ./worker/.env; set +a
npm run record:unpublish <record-id>
```

That republishes the chunk without the record under a fresh id and repoints the
manifest, leaving the superseded chunk unreferenced. The manifest is written
last: a chunk nothing points at is invisible, while a record missing from a
chunk the manifest still points at would be a broken page.

**What expires.** Drafts, originals and contact messages are deleted after
`draft_retention_days` (7), error logs after `error_log_retention_days` (14),
abandoned multipart uploads after a day. The content and media buckets have no
lifecycle rule — published records and the media they reference are meant to
last.

Changing the profile is not a publication and rebuilds nothing on its own:

```sh
npm run profile:publish
gh workflow run deploy-pages.yml --ref main
```

## The contact form

`/contact/` is a page in the same static build as everything else — a real
`contact/index.html`, served by Pages with a 200 and its own title. Site
routing is declared once in `site/src/routes.ts`, which is both the build's
list of entry points and the browser's list of navigation links; nothing
intercepts history and nothing falls back through `404.html`.

Sending a message crosses four systems, and the split is the same one the media
pipeline uses: the thing that screens content is not the thing that decides what
reaches her.

1. **The browser** solves a Cloudflare Turnstile challenge and posts the three
   fields and the token to the Worker's `/contact`.
2. **The Worker** accepts only its own site's origin, checks the field lengths,
   allows one submission per address per minute, and asks Cloudflare to verify
   the token. It then writes the message to `contact/<id>/submission.json` in
   the private bucket and dispatches `validate-contact.yml`, passing a
   submission id and a job token and nothing else — workflow inputs are visible
   in the Actions UI. The visitor is told the message was *accepted*, which is
   all that is true yet.
3. **The Actions job** reads that one object with read-only credentials, asks
   Workers AI whether the message is spam and whether it is coherent, and posts
   the verdict back to `/callbacks/contact-checked`, signed with
   `CALLBACK_HMAC_SECRET` exactly as the media callback is. It never prints the
   message: not to a log, not to the run summary, and not through an API error,
   which is scrubbed of the message text before it is shown.
4. **The Worker** forwards the message to the first id in
   `TELEGRAM_ALLOWED_USER_IDS` — the author, who is already identified to it —
   or, on a `discard` verdict, sends nothing at all. The words that arrive are
   the stored ones; a signed callback carrying different text could not put them
   in front of her.

The whole round trip is a minute or two, which is why the page never claims
delivery. A job that fails at any stage reports `undetermined` rather than
dying quietly, and the message is forwarded carrying a line saying it was never
screened: a genuine message must not be lost because a model was unavailable. A
message Telegram itself refuses stays in `checking`, so re-running the workflow
delivers it.

Three things turn it off rather than breaking it. Without `TURNSTILE_SITE_KEY`
or `WORKER_BASE_URL` the page renders a notice instead of a form, and the Pages
workflow warns. Without `TURNSTILE_SECRET_KEY` the Worker refuses every
submission and says so once in its log.

Amplitude records `contact_page_viewed`, `contact_form_submitted` (with the
message's length, never its text), and then `contact_message_queued` or
`contact_form_rejected` with the reason.

## Backups and export

Nothing here is backed up automatically, and two of the things that matter live
in exactly one place.

**The published history** is the manifest and its chunks in the content bucket;
**the media** is the derivatives in the media bucket. Neither expires, but
neither has a second copy either, and an object overwritten in R2 has no earlier
version to fall back to. Export both with any S3 client, using an R2 token with
Object Read-only over the two buckets:

```sh
podman run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION=auto \
  -v "$PWD/backup":/backup:z docker.io/amazon/aws-cli:latest \
  --endpoint-url "https://<account-id>.r2.cloudflarestorage.com" \
  s3 sync "s3://<slug>-content" /backup/content
```

The site is a pure function of those objects and the profile, so that pair plus
the repository is enough to rebuild it anywhere.

**The profile's source of truth** is `private-inputs/profile/`, which is
gitignored and therefore exists only on the machine that wrote it. The copy in
the content bucket is not a substitute: `profile:publish` strips the
authoring-only fields on the way out, so restoring from it loses the material
that made the profile reviewable. Back up that directory with whatever holds
the rest of the private inputs.

**Terraform state** for the main stack is in the state bucket, and the same
command copies it if the token also reads that bucket and the prefix is your
project's. The bootstrap stack's state is the local
`terraform.tfstate`, untracked, and it is the only record that the state bucket
is managed. Losing it is recoverable — `terraform import` re-adopts the bucket —
but losing it silently is how a bucket ends up owned by nobody.

**Secrets cannot be read back** out of GitHub or Cloudflare. The two generated
here, `CALLBACK_HMAC_SECRET` and `TELEGRAM_WEBHOOK_SECRET`, exist in both a
GitHub secret and a Worker secret, and neither will show you its value again.
Keep them wherever the API tokens are kept, or accept that recovery means
rotating both sides at once.

**Drafts and originals are not backed up on purpose.** They are unapproved
content and unsanitized media, and the lifecycle rule deleting them after a
week is a feature of the design rather than a gap in it.

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
| `check-config.yml` | pull request, push to main | actionlint (which is what parses `process-media.yml` and `validate-contact.yml`, since nothing else ever does), the config inventory, the media workflow's steps, the security rules |
| `check-media.yml` | pull request, push to main | the sanitiser's Rust tests |
| `deploy-worker.yml` | push to main | typecheck + the Worker suite against the real profile, then deploys |

Each of the three checks is path-filtered to what it can be affected by, and
runs every one of its suites when it triggers at all. A pull request touching
only documentation therefore reports no checks — an empty list there means
nothing was relevant, not that something failed to start. A run that never
appears when it should have is usually a workflow GitHub could not parse; those
surface as a zero-second run named after the file, which `gh run list --branch`
shows and `gh pr checks` does not.

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
[Step 5](#5-set-the-repository-variables-and-secrets) says where each value
comes from.

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
state or change infrastructure, so it uses its own read-only pair —
`CLOUDFLARE_API_TOKEN_PLAN` and `R2_STATE_RO_*`, created alongside their
writable counterparts in step 5. `terraform plan` never persists state, so read
access is enough. The job stops with a named error until both exist.

`scripts/derive-r2-s3-credentials.sh` is the reference for how an R2 API token
becomes an S3 pair. Read it for the mechanics rather than running it against a
read-only token: it writes its result into `infrastructure/.env`, overwriting
the write credentials there.

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
