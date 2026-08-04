# Implementation Plan: Personal Portfolio — Reusable Static Portfolio System

## Context

Build the system specified in `the specification PDF` (38 pages, read in full): a **reusable, fully static personal portfolio** whose first deployment is for the author. Visitors only ever touch GitHub Pages + public R2 JSON/media — no Worker, DB, or runtime API on page reads. Content is authored through a Telegram bot → Cloudflare Worker → Workers AI flow with preview/approve/edit/regenerate/cancel/publish, published as immutable 10-record JSON chunks behind a `manifest.json`, media sanitized (EXIF scrub + decoy metadata) in ephemeral GitHub Actions storage, and all infrastructure managed by reusable Terraform. **No personal names, domains, IDs, bucket names, or secrets in tracked files** — everything personalized comes from gitignored files, GitHub variables/secrets, and Worker secrets.

Decisions confirmed with the user:
- **Scope:** all 7 spec phases, fully broken down.
- **Site stack:** Vite + vanilla TypeScript (no framework).
- **Profile inputs:** the author's real source material is in `the private source directory`: two CVs (docx + PDF), `personal_portfolio_reflection.pdf` (the Corporate Copilot characteristics output — already produced, so no Copilot prompt needs writing), `Personal Portfolio About Me.pdf` (approved ~175-word About text), `main_foto.jpeg` (hero), and hobby photos (`hobby_jogging.jpeg`, `hobby_jym.jpeg`, `hobby_stretching.jpeg`).
- **Task tracking:** all tasks go into the user's GitHub Project the project board — existing items removed, project renamed to "Personal Portfolio". (`gh` CLI is not installed yet; installing + authenticating it is part of Task 1.)

The working directory `/home/rooss/Projects/real-one-portfolio` is empty — greenfield. First implementation step creates the repo skeleton and copies this breakdown to `tasks/plan.md` + `tasks/todo.md` (the convention the `/build` skill consumes).

## Architecture decisions (from the spec — fixed, not open)

- 4 R2 buckets: private (drafts/ + originals/, 7-day lifecycle), public content (`content/manifest.json`, `content/records-{id}.json`), public media (`media/activity-{id}/...`), terraform-state (bootstrap-created, local-state bootstrap stack).
- Records: immutable chunks, ≤10 entries, crypto-random IDs, manifest stores IDs only, `latest` pointer, manifest written last, ETag-conditional writes.
- Cache: records `public, max-age=31536000, immutable`; manifest `no-cache` (or `max-age=60, must-revalidate`).
- Worker (TypeScript, Wrangler): Telegram webhook only — never in the page-read path. Draft states: `draft → awaiting_approval → [processing →] published | failed | cancelled`.
- Media: GitHub Actions downloads originals from private R2, scrubs EXIF/GPS/IPTC/XMP, injects configured decoy metadata (Sony Alpha, 2117 dates, Alpine GPS list from config), generates WebP/AVIF derivatives + poster frames (video: H.264/AAC), uploads to public media R2, calls HMAC-signed Worker callback (timestamp + nonce + constant-time compare + idempotency).
- Terraform: `bootstrap/` (local gitignored state → state bucket) and `main/` (`backend "s3" {}` + gitignored `backend.private.hcl`); names derived from variables; `concurrency: terraform-production` in Actions.
- Repo layout per spec §4: `site/`, `profile/`, `worker/`, `infrastructure/{bootstrap,main}/`, `scripts/` (`generate-wrangler.ts`, `bootstrap-manifest.ts`, `validate-profile.ts`), `.github/workflows/` (terraform-plan, terraform-apply, deploy-worker, process-media, deploy-pages).

## Task list

Sizing: S = 1–2 files, M = 3–5 files. Verification commands assume repo root.
Tracking: every task lives as an item in GitHub Project "Personal Portfolio" (the project board); as work proceeds, items move Todo → In Progress → Done via `gh project item-edit`.

### Phase 0 — Repository foundation

**Task 1: Repo skeleton, .gitignore, plan files, GitHub Project board** (M)
Create directory tree per spec §4, `git init`, README stub, `FABLE_PROMPT.txt` placeholder, root `.gitignore` covering `*.auto.tfvars`, `backend.private.hcl`, `worker/.dev.vars`, `worker/.env`, `worker/wrangler.generated.json`, `terraform.tfstate*`, `.terraform/`, `node_modules/`, `dist/`, plus a `private-inputs/` dir (gitignored) holding copies of the source material from `the private source directory`. Copy this breakdown to `tasks/plan.md` and `tasks/todo.md`.
Then set up tracking in GitHub Project #2 (`the project board`): install GitHub CLI (`sudo dnf install gh`), user authenticates (`gh auth login` + `gh auth refresh -s project`), **delete all existing items** from the project, **rename it to "Personal Portfolio"**, and create one item per task below (title = task name, body = description + acceptance criteria, grouped by phase).
- Accept: tree matches spec §4; `git status` shows no ignored file as trackable; plan files exist; project board renamed, emptied of old items, and populated with all tasks.
- Verify: `git check-ignore` on each sensitive pattern; `gh project item-list 2 --owner <owner>` shows exactly this plan's tasks.
- Deps: none. (gh auth login is interactive — user runs it via `! gh auth login` when prompted.)

### Phase 1 — Profile Generator and design inputs

**Task 2: Profile JSON schemas + validation script** (M)
JSON Schemas for `facts.json`, `personality.json`, `design.json`, `portfolio.json` (schemaVersion, explicit `null`/content-status conventions, verified/provisional/approved distinction in personality) and `scripts/validate-profile.ts` that validates all four against schemas and rejects deployment-specific values (no domains, IDs, bucket names).
- Accept: script exits non-zero on invalid/missing fields, private fields, or deployment values; passes on valid examples.
- Verify: `npx tsx scripts/validate-profile.ts` against a good and a deliberately bad fixture.
- Deps: 1.

**Task 3: Fable generation prompt** (S)
Write `FABLE_PROMPT.txt`: instructions for a design model to build the site from `profile/` without inventing facts. *(The Copilot characteristics prompt from spec §5.5 is dropped — its output already exists as `personal_portfolio_reflection.pdf`.)*
- Accept: prompt requests only spec-listed items; no personal data embedded in the tracked prompt file.
- Deps: 1.

**Task 4: Generate and approve the author's profile files** (M)
Run the Profile Generator flow on the real inputs from `private-inputs/`: the CV, `personal_portfolio_reflection.pdf` (Copilot characteristics — feeds `personality.json`: verified observations, communication style, values, motivations, the balanced AI-as-one-interest treatment), `Personal Portfolio About Me.pdf` (approved About text), `main_foto.jpeg`, and hobby photos. Draft the four JSONs, human review with the author's corrections, finalize. Design rules per spec §6: light-yellow jacket palette anchor, warm off-white, soft charcoal, natural photography, not corporate/AI-startup/dark-dev. Note: spec §6.4 lists hobbies Photography/Jogging/Ballet, but available photos are jogging/gym/stretching — confirm the final hobby list with the author at review.
- Accept: `validate-profile.ts` passes; facts contain only verified data (uncertain = `null`); personality distinguishes verified/provisional/approved; AI appears as one interest among several; no deployment-specific values.
- Verify: validation script + manual review checkpoint with the user.
- Deps: 2, 3.

**Checkpoint A:** four valid profile files approved; prompts written; repo clean of personal deployment values.

### Phase 2 — Static portfolio site

**Task 5: Vite + vanilla TS site scaffold** (M)
`site/` with Vite, TypeScript, `index.html`, base styles implementing `design.json` tokens (palette from hero jacket, warm off-white bg, charcoal text, spacious editorial layout), reduced-motion support, build reading profile JSONs at build time.
- Accept: `npm run dev` serves; `npm run build` emits static `dist/`; no runtime API calls.
- Verify: `npm run build && npx vite preview`.
- Deps: 4 (uses profile files; can start from schemas if 4 is pending).

**Task 6: Hero + About sections** (S)
Top viewport: portrait, name, short warm intro (from `facts.json`/`personality.json`), one–two actions ("Discover my story", "See recent activities"). About section below.
- Accept: content sourced from profile JSONs only; responsive at 360px/768px/1280px; editorial crop on hero.
- Deps: 5.

**Task 7: Experience + Hobbies sections** (S)
Selected experience entries; hobby cards (title, short personal explanation, approved image, optional related activities) for Photography, Jogging, Ballet.
- Accept: renders from `portfolio.json`/`facts.json`; images are placeholder-pathed until Phase 5 provides sanitized derivatives.
- Deps: 5.

**Task 8: Static Activity loader** (M)
Client-side TS module implementing spec §21: fetch manifest once → derive `records-{id}.json` URLs → download chunks from public content domain (from build-time config, not hardcoded) → merge → sort descending (ascending toggle client-side) → render. Graceful states: manifest unavailable, malformed chunk, empty manifest.
- Accept: works against local fixture chunks; no Worker involvement; content-domain configurable via env at build.
- Verify: serve fixtures locally, check all error states.
- Deps: 5.

**Task 9: GitHub Pages deployment** (S)
`.github/workflows/deploy-pages.yml`: build site with GitHub-variables-supplied config (content domain etc.), deploy to Pages. Custom-domain + Enforce-HTTPS documented in README (manual Pages settings).
- Accept: workflow green on push to main; no personalized values in the workflow file itself.
- Verify: Actions run + live Pages URL.
- Deps: 5–8 (needs a buildable site).

**Checkpoint B:** portfolio live on GitHub Pages with hero/About/Experience/Hobbies and an Activity section rendering fixture data. All config via variables.

### Phase 3 — Cloudflare infrastructure (Terraform)

**Task 10: Bootstrap stack** (M)
`infrastructure/bootstrap/`: versions, providers, variables, `state-bucket.tf`, outputs. Local state, gitignored. Creates only the terraform-state R2 bucket (private, no lifecycle deletion, no public domain).
- Accept: `terraform init && terraform plan` clean with a local `bootstrap.auto.tfvars`; no literal names in tracked files.
- Verify: `terraform validate` + plan review; apply when user provides Cloudflare credentials.
- Deps: 1.

**Task 11: Main stack — buckets, lifecycle, domains, DNS** (M)
`infrastructure/main/`: `backend "s3" {}` + `backend.hcl.example` + `config.auto.tfvars.example`; private bucket (7-day lifecycle on `drafts/` and `originals/`), public content bucket + `content.<root-domain>` custom domain, public media bucket + `media.<root-domain>`, DNS records, GitHub Pages DNS, cache policies. All names derived from variables.
- Accept: `terraform validate` passes; plan shows 4-bucket topology; grep confirms no person/domain/ID literals in tracked `.tf`.
- Verify: `terraform plan` with example tfvars; CI workflows in Task 12.
- Deps: 10.

**Task 12: Worker foundation in Terraform + Terraform CI workflows** (M)
Worker infrastructure resources (custom domain, DNS) in main stack; `.github/workflows/terraform-plan.yml` (PRs, no apply) and `terraform-apply.yml` (protected, `concurrency: terraform-production`, `cancel-in-progress: false`).
- Accept: only the protected workflow can apply; plan workflow needs no write credentials beyond state read.
- Deps: 11.

**Checkpoint C:** `terraform apply` succeeds against the user's Cloudflare account (user supplies tfvars/secrets); buckets, domains, lifecycle live; state in R2.

### Phase 4 — Telegram text-only publishing

**Task 13: Worker scaffold + wrangler template + generate-wrangler script** (M)
`worker/` TS project: `wrangler.template.json` (tracked, placeholder names), `scripts/generate-wrangler.ts` producing gitignored `wrangler.generated.json` from env/variables; R2 + Workers AI bindings; `src/index.ts` router; `.dev.vars.example`.
- Accept: `wrangler dev` runs locally with generated config; template contains no real names.
- Verify: `npm run dev` in worker/ + smoke request.
- Deps: 11 (bucket names/bindings), 1.

**Task 14: Telegram webhook verification + sender allowlist** (S)
`src/telegram/`: webhook secret check, allowed-user-ID check (from secrets/vars), reject otherwise. Webhook registration documented/scripted.
- Accept: invalid secret → 401; non-allowlisted sender → ignored; tests cover both.
- Verify: `npm test` (vitest) with mocked requests.
- Deps: 13.

**Task 15: Draft creation + private R2 storage** (M)
`src/drafts/`: on incoming text — crypto-random draft ID, draft JSON at `drafts/{draft-id}/draft.json`, state machine (`draft`, `awaiting_approval`, `processing`, `published`, `failed`, `cancelled`) stored in draft JSON.
- Accept: draft persisted with correct shape + state; IDs non-sequential, content-independent.
- Verify: unit tests with R2 mock; `wrangler dev` manual flow.
- Deps: 14.

**Task 16: Workers AI integration with structured output** (M)
`src/ai/`: title/summary/body/tags/eventDate generation returning validated structured JSON (spec §8 example shape); schema validation of AI response; retries; quota-exhausted path ("draft saved, AI can continue later"). Deterministic code (never the model) controls IDs, paths, state, URLs.
- Accept: malformed AI output rejected + retried; quota failure leaves draft intact with friendly Telegram message.
- Verify: unit tests with mocked AI responses (valid/invalid/error).
- Deps: 15.

**Task 17: Telegram preview + approval buttons** (M)
`src/telegram/` + `src/drafts/`: preview showing exactly what becomes public (title, date, summary, full body, tags); inline buttons Publish / Edit text / Change media / Regenerate / Cancel; used buttons disabled; full preview re-sent after every regeneration.
- Accept: preview matches draft JSON exactly; button callbacks routed with opaque tokens; state transitions per spec §22.
- Verify: unit tests + live bot smoke test.
- Deps: 16.

**Task 18: Edit / regenerate / cancel flows** (M)
Edit: retrieve draft → user instruction → Workers AI with current draft + instruction + output schema → validate → update → full preview again. Regenerate + cancel per spec.
- Accept: each flow updates state correctly; complete preview after each change; cancel marks draft cancelled (lifecycle cleans up).
- Deps: 17.

**Task 19: Text-only publication — immutable chunks + manifest** (M)
`src/publishing/` + `src/content/`: append-to-latest-chunk algorithm per spec §9.5 (new chunk under new random ID, replace manifest entry, update `latest`, manifest last; roll new chunk at 10 records), ETag-conditional manifest writes with reread-retry on conflict, cache headers per §9.6, published URL sent to Telegram. Publish idempotent (repeated click safe). `scripts/bootstrap-manifest.ts` creates the empty manifest.
- Accept: chunks immutable; manifest stores IDs only; ETag conflict path tested; double-publish yields one record.
- Verify: unit tests for chunk math + concurrency; end-to-end: Telegram text → published JSON → visible on the live Activity page.
- Deps: 17, 11.

**Task 20: Worker deploy workflow** (S)
`.github/workflows/deploy-worker.yml`: generate wrangler config from GitHub variables, deploy with Wrangler, secrets via GitHub secrets → Worker secrets.
- Accept: green deploy; no secret/name literals in workflow.
- Deps: 13, 19.

**Checkpoint D:** full text-only loop works in production: Telegram message → AI draft → preview → approve → immutable chunk + manifest in public R2 → renders on the live site. No Worker involvement in page reads (verify via browser network tab).

### Phase 5 — Photo pipeline

**Task 21: Photo intake + originals in private R2 + media preview** (M)
Worker handles photo messages (single + album): store originals at `originals/{activity-id}/`, media preview via Telegram file reference or R2 retrieval; album + separate control message with buttons for multi-media drafts.
- Accept: originals only in private R2; preview shows selected photos with captions/alt from AI; no public object before approval.
- Deps: 19.

**Task 22: GitHub Actions dispatch + process-media workflow — sanitization** (M)
On Publish for media drafts: state → `processing`, Worker calls workflow-dispatch with `{draftId, jobToken}` only. `.github/workflows/process-media.yml`: checkout, install exiftool/sharp, fetch draft metadata, download originals from private R2 (read-only creds), in runner temp storage: strip EXIF/GPS/IPTC/XMP/thumbnails (apply orientation first), inject decoy metadata from config (Make: Sony, Model: Alpha, DateTimeOriginal 2117 randomized, GPS from configurable 10-Alpine-peak list — stored in reusable config, not hardcoded).
- Accept: `exiftool` on outputs shows no original metadata, decoy fields present; raw media never in git or artifacts; no private URLs/credentials printed.
- Verify: run workflow against a GPS-tagged test image; inspect output metadata in job log via safe summary.
- Deps: 21.

**Task 23: Derivatives, validation, public upload** (M)
Same workflow: generate sanitized hi-res + large + medium WebP/AVIF + thumbnail (no upscale, preserve aspect/tones), validate dimensions/quality, upload to public media R2 `media/activity-{id}/` (write-only creds to that bucket; no state or manifest access).
- Accept: derivative set complete; validation fails the job on bad output without touching public JSON.
- Deps: 22.

**Task 24: HMAC callback endpoint + media publication** (M)
`src/callbacks/`: `POST /callbacks/media-processed` verifying `X-Callback-Timestamp/Nonce/Signature` (HMAC over `timestamp.nonce.body`, constant-time compare, recent timestamp, nonce single-use, draft in `processing`, job ID + media IDs match, URLs on configured public media domain, not already completed). On success: public record JSON with media URLs → chunk + manifest (reusing Task 19 code) → Telegram success. Idempotent: repeat callback returns existing result, no double-publish/manifest/messages. Action-side signing step added to the workflow.
- Accept: all 10 validation checks tested; duplicate callback safe; failure path → `failed` + Retry/Cancel buttons in Telegram, draft retained.
- Verify: unit tests for signature/nonce/idempotency; end-to-end: Telegram photo → published record with sanitized public media rendering on the live site.
- Deps: 22, 23, 19.

**Checkpoint E:** photo publication works end-to-end; `exiftool` on live public images shows only decoy metadata; originals expire from private R2 after 7 days.

### Phase 6 — Video pipeline

**Task 25: Video intake + transcode + sanitize** (M)
Extend intake (Task 21) for videos; extend process-media workflow: ffmpeg strip container/encoder/GPS/device metadata, H.264/AAC transcode with high-quality CRF (avoid resize unless required), preserve duration/audio, poster frame, decoy injection only where container-reliable, input/output property comparison.
- Accept: `ffprobe` shows no original metadata; duration/audio preserved; poster generated.
- Verify: test matrix — MOV, MP4, GPS-tagged, no-audio, oversized, invalid file.
- Deps: 24.

**Task 26: Optional processed-video confirmation + publication** (S)
If transcoding materially changes the video, send processed result back to Telegram for final confirmation before publication; otherwise publish as photos do.
- Accept: confirmation path gated correctly; publication reuses callback/publishing code.
- Deps: 25.

**Checkpoint F:** video publication end-to-end with sanitized output on the live site.

### Phase 7 — Reliability and maintenance

**Task 27: Failure flows + retry** (M)
`processing → failed → retry → processing` per spec §22–23: GitHub Actions failure → Telegram "Publication failed… [Retry] [Cancel]"; invalid media output → no public JSON/manifest change, draft retained until retry/cancel/expiry; Workers AI quota message; expired-draft handling.
- Accept: each spec §23 scenario has a test; retry reuses the same draft/activity IDs safely.
- Deps: 24 (26 for video paths).

**Task 28: Test suite consolidation + CI** (M)
Vitest suites covering spec §26 lists: profile validation, Worker (sender validation, webhook secret, draft creation, AI schema, repeated publish, expired draft, AI failure, R2 write failure, ETag conflict, duplicate callback), site loader states (empty/malformed/one/many chunks, both sort orders). Wire into CI on PRs.
- Accept: `npm test` green across workspaces; CI enforces on PR.
- Deps: 19, 24 (extends as later tasks land).

**Task 29: Log hygiene + security pass** (S)
Audit Worker + workflow logs: no private URLs, tokens, or personal data; pinned third-party actions by SHA; minimal workflow permissions; no secrets in PR-triggered workflows; production environment protection documented.
- Accept: grep of log statements + workflow files confirms; spec §24 checklist all ticked.
- Deps: 20, 24.

**Task 30: README + runbook** (S)
Document: new-person deployment (fill tfvars/backend.hcl/variables/secrets → bootstrap → main → deploy), domain registration via Cloudflare Registrar (manual), Pages custom-domain setup, draft lifecycle, backup/export strategy note.
- Accept: a new deployment is reproducible from README alone without reading source.
- Deps: all prior.

**Checkpoint G (final):** full spec compliance sweep — static reads only (network tab), no personalization in tracked files (grep sweep), lifecycle rules verified, all tests green.

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Workers AI output quality/instability for structured JSON | Med | Strict schema validation + retry + quota-safe draft retention (Task 16) |
| R2 manifest race (no native TF-style locking) | Med | ETag conditional writes + reread-retry (Task 19); Actions concurrency group for Terraform |
| Telegram file-size limits for videos via Bot API | Med | Bot API caps downloads (~20MB); document limit, keep originals path via R2 retrieval; surface friendly error |
| Decoy metadata not supported by some containers | Low | Inject only where reliable (spec §11.3); removal always happens |
| Secrets sprawl across GitHub/Worker/Terraform | Med | Single README matrix of every variable/secret and where it lives (Task 30) |

## Open questions (non-blocking; resolve at the relevant task)

- Root domain choice + Cloudflare Registrar purchase (manual, needed by Checkpoint C).
- Telegram bot creation (BotFather) — user action before Task 14 live testing.

## Verification (end-to-end)

1. `npm test` green in `site/` and `worker/`; `terraform validate` in both stacks.
2. Live site loads with browser network tab showing only Pages + `content.*` + `media.*` requests.
3. Telegram: text and photo drafts through preview → publish → visible on site; `exiftool` on a live image shows decoy-only metadata.
4. Grep sweep of tracked files for the person's name, domain, account IDs, bucket names — zero hits.
