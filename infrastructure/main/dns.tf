# GitHub Pages records.
#
# DNS-only by default, and for a real reason: GitHub issues and renews the
# certificate for the custom domain itself, and it can only do that when it sees
# the real origin.
#
# `site_preview_enabled` proxies them anyway, because a Workers route only runs
# on a hostname Cloudflare proxies and preview.tf needs one on /activities* —
# without it a shared `?v=` link previews as the whole feed, since the site is
# static and the record it names arrives afterwards by JavaScript no crawler
# runs. What makes that safe is the SSL mode pinned beside the route: visitors
# are served Cloudflare's own certificate, and Cloudflare accepts whatever the
# origin presents on the leg behind it, so a failed GitHub renewal cannot take
# the site down. Turning the flag off puts these back exactly as they were.
resource "cloudflare_dns_record" "site_ipv4" {
  count = local.serve_site_from_apex ? length(local.github_pages_ipv4) : 0

  zone_id = var.cloudflare_zone_id
  name    = var.root_domain
  type    = "A"
  content = local.github_pages_ipv4[count.index]
  ttl     = 1
  proxied = var.site_preview_enabled
  comment = "GitHub Pages"
}

resource "cloudflare_dns_record" "site_ipv6" {
  count = local.serve_site_from_apex ? length(local.github_pages_ipv6) : 0

  zone_id = var.cloudflare_zone_id
  name    = var.root_domain
  type    = "AAAA"
  content = local.github_pages_ipv6[count.index]
  ttl     = 1
  proxied = var.site_preview_enabled
  comment = "GitHub Pages"
}

resource "cloudflare_dns_record" "site_cname" {
  count = local.serve_site_from_apex ? 0 : 1

  zone_id = var.cloudflare_zone_id
  name    = local.site_hostname
  type    = "CNAME"
  content = "${var.github_pages_owner}.github.io"
  ttl     = 1
  proxied = var.site_preview_enabled
  comment = "GitHub Pages"

  lifecycle {
    precondition {
      condition     = var.github_pages_owner != ""
      error_message = "github_pages_owner must be set when site_subdomain is used, because the CNAME target is <owner>.github.io."
    }
  }
}
