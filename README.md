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
