# Task Checklist — Personal Portfolio

Details, acceptance criteria, and verification for every task: see `tasks/plan.md`.
Tracking mirror: GitHub Project "Personal Portfolio" (the project board).

## Phase 0 — Repository foundation
- [x] Task 1: Repo skeleton, .gitignore, plan files, GitHub Project board

## Phase 1 — Profile Generator and design inputs
- [x] Task 2: Profile JSON schemas + validation script
- [x] Task 3: Fable generation prompt
- [x] Task 4: Generate and approve the author's profile files
- [x] Checkpoint A: profile files approved, repo clean of personal deployment values

## Phase 2 — Static portfolio site
- [x] Task 5: Vite + vanilla TS site scaffold
- [x] Task 6: Hero + About sections
- [x] Task 7: Experience + Hobbies sections
- [x] Task 8: Static Activity loader
- [x] Task 9: GitHub Pages deployment
- [x] Checkpoint B: portfolio live on Pages (Activity states verified against local fixtures; live feed pending Cloudflare content bucket)

## Phase 3 — Cloudflare infrastructure (Terraform)
- [x] Task 10: Bootstrap stack
- [x] Task 11: Main stack — buckets, lifecycle, domains, DNS
- [x] Task 12: Worker foundation in Terraform + Terraform CI workflows
- [x] Checkpoint C: terraform apply succeeds, buckets/domains live
      (root domain active on Cloudflare; 4 buckets, both public custom
      domains, 7-day lifecycle, Pages DNS; site live on the domain)

## Phase 4 — Telegram text-only publishing
- [x] Task 13: Worker scaffold + wrangler template + generate-wrangler script
- [x] Task 14: Telegram webhook verification + sender allowlist
- [x] Task 15: Draft creation + private R2 storage
- [x] Task 16: Workers AI integration with structured output
- [x] Task 17: Telegram preview + approval buttons
- [x] Task 18: Edit / regenerate / cancel flows
- [x] Task 19: Text-only publication — immutable chunks + manifest
- [x] Task 20: Worker deploy workflow
- [ ] Checkpoint D: full text-only loop works in production

## Phase 5 — Photo pipeline
- [x] Task 21: Photo intake + originals in private R2 + media preview
- [x] Task 22: GitHub Actions dispatch + process-media workflow — sanitization
- [x] Task 23: Derivatives, validation, public upload
- [x] Task 24: HMAC callback endpoint + media publication
- [ ] Checkpoint E: photo publication end-to-end, decoy-only metadata live

## Phase 6 — Video pipeline
- [x] Task 25: Video intake + transcode + sanitize
- [x] Task 26: Optional processed-video confirmation + publication
- [x] Checkpoint F: video publication end-to-end
      (three clips published from Telegram — a 4K one confirmed through the
      changed-video gate, an HD one straight through, and a 36.1 MB one refused
      with the Bot API's 20 MB download limit named; ffprobe on a live published
      file shows only the decoy make/model/GPS, no creation_time, H.264/AAC)

## Phase 7 — Reliability and maintenance
- [x] Task 27: Failure flows + retry
      (a run that does not finish posts a signed report to
      /callbacks/media-failed; the draft moves to `failed` and the author gets
      "Publication failed…" with Retry and Cancel. Retry reuses the same draft
      and activity id with a fresh job token, and republishes from the uploaded
      files rather than sanitising them twice)
- [x] Task 28: Test suite consolidation + CI
      (`npm test` runs all three suites — profile validation, the Worker, the
      site's Activity loader — and tests.yml runs them plus the typechecks on
      every pull request. The suites take the tracked fixture profile when
      profile/*.json is absent, so the gate needs no variables or secrets)
- [x] Task 29: Log hygiene + security pass
      (audited every Worker log statement and eight real public run logs: no
      credential appears anywhere, and the deployment identifiers that do are
      variables rather than secrets by an earlier decision. Third-party actions
      are now pinned by commit or image digest, and `npm run security:check`
      keeps them there along with declared permissions, accounted-for writes,
      and no unguarded secret a pull request can reach. One leak found and
      fixed: proxy.test.ts carried the live domain)
- [x] Task 30: README + runbook
      (the README now carries an eleven-step deployment runbook — domain and
      zone, local credentials, bootstrap stack, main stack, every repository
      variable and secret with where its value comes from, profile and
      manifest, Telegram, the Worker-then-hostname ordering, Pages and its
      custom domain, the production gate, and a verification pass — plus the
      draft lifecycle with its state table and a backups/export section naming
      what has only one copy)
- [ ] Checkpoint G: full spec compliance sweep
