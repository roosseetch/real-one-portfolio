# What makes a shared activity link preview as that activity.
#
# The site is static, and deliberately stays so. `site/vite.config.ts` writes the
# title and the og: tags into /activities/index.html at build time, when no
# record exists to describe, and the record a `?v=` link names is fetched from
# the content bucket afterwards by JavaScript no crawler runs. So the one page
# that has to vary by query string is routed through the Worker, which fetches
# that same static page and rewrites its head — worker/src/share/preview.ts.
#
# Nothing else on the site is touched. The pattern matches /activities and what
# follows it and nothing more, so the landing page, /contact and every hashed
# asset are served by GitHub Pages exactly as before, and a Worker fault can only
# ever affect the one page it answers.
#
# A route rather than a custom domain, unlike worker.tf. A custom domain hands
# the whole hostname to the script with no origin behind it; a route sits in
# front of one, which is what lets the handler fetch the page it is rewriting.
resource "cloudflare_workers_route" "site_activities" {
  count = var.site_preview_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  pattern = "${local.site_hostname}/activities*"
  script  = var.worker_name

  lifecycle {
    precondition {
      condition     = var.worker_enabled
      error_message = "site_preview_enabled requires worker_enabled: the route has to point at a script that exists, and worker_enabled is what says Wrangler has deployed it."
    }
  }
}

# The setting that makes proxying a GitHub Pages origin safe.
#
# dns.tf keeps the site's records DNS-only precisely so GitHub can renew the
# Pages certificate against the real origin, and the route above needs them
# proxied. `full` is what reconciles the two: visitors are served Cloudflare's
# own certificate, and Cloudflare accepts whatever the origin presents on the
# leg behind it. A GitHub renewal that fails is then a certificate nobody sees
# rather than a site nobody can reach.
#
# Deliberately not `strict`, which is the version that would validate the
# origin's certificate and hand a visitor a 526 the moment GitHub's lapsed —
# which is the exact failure this exists to absorb.
#
# Declared here rather than left in the dashboard because it is load-bearing for
# the resource above it, and because the default for a new zone is not this. A
# zone left on `flexible` would answer the origin over plain HTTP, which GitHub
# redirects back to HTTPS, which is a redirect loop and a site that is down.
resource "cloudflare_zone_setting" "ssl" {
  count = var.site_preview_enabled ? 1 : 0

  zone_id    = var.cloudflare_zone_id
  setting_id = "ssl"
  value      = "full"
}
