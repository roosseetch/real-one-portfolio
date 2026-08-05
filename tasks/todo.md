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
      (the-root-domain active on Cloudflare; 4 buckets, both public custom
      domains, 7-day lifecycle, Pages DNS; site live at https://the-root-domain)

## Phase 4 — Telegram text-only publishing
- [x] Task 13: Worker scaffold + wrangler template + generate-wrangler script
- [x] Task 14: Telegram webhook verification + sender allowlist
- [x] Task 15: Draft creation + private R2 storage
- [x] Task 16: Workers AI integration with structured output
- [x] Task 17: Telegram preview + approval buttons
- [x] Task 18: Edit / regenerate / cancel flows
- [ ] Task 19: Text-only publication — immutable chunks + manifest
- [ ] Task 20: Worker deploy workflow
- [ ] Checkpoint D: full text-only loop works in production

## Phase 5 — Photo pipeline
- [ ] Task 21: Photo intake + originals in private R2 + media preview
- [ ] Task 22: GitHub Actions dispatch + process-media workflow — sanitization
- [ ] Task 23: Derivatives, validation, public upload
- [ ] Task 24: HMAC callback endpoint + media publication
- [ ] Checkpoint E: photo publication end-to-end, decoy-only metadata live

## Phase 6 — Video pipeline
- [ ] Task 25: Video intake + transcode + sanitize
- [ ] Task 26: Optional processed-video confirmation + publication
- [ ] Checkpoint F: video publication end-to-end

## Phase 7 — Reliability and maintenance
- [ ] Task 27: Failure flows + retry
- [ ] Task 28: Test suite consolidation + CI
- [ ] Task 29: Log hygiene + security pass
- [ ] Task 30: README + runbook
- [ ] Checkpoint G: full spec compliance sweep
