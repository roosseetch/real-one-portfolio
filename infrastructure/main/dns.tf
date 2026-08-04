# GitHub Pages records.
#
# These stay DNS-only (proxied = false). GitHub issues and renews the
# certificate for the custom domain itself, and it can only do that when it
# sees the real origin. Proxying them would break certificate renewal.
resource "cloudflare_dns_record" "site_ipv4" {
  count = local.serve_site_from_apex ? length(local.github_pages_ipv4) : 0

  zone_id = var.cloudflare_zone_id
  name    = var.root_domain
  type    = "A"
  content = local.github_pages_ipv4[count.index]
  ttl     = 1
  proxied = false
  comment = "GitHub Pages"
}

resource "cloudflare_dns_record" "site_ipv6" {
  count = local.serve_site_from_apex ? length(local.github_pages_ipv6) : 0

  zone_id = var.cloudflare_zone_id
  name    = var.root_domain
  type    = "AAAA"
  content = local.github_pages_ipv6[count.index]
  ttl     = 1
  proxied = false
  comment = "GitHub Pages"
}

resource "cloudflare_dns_record" "site_cname" {
  count = local.serve_site_from_apex ? 0 : 1

  zone_id = var.cloudflare_zone_id
  name    = local.site_hostname
  type    = "CNAME"
  content = "${var.github_pages_owner}.github.io"
  ttl     = 1
  proxied = false
  comment = "GitHub Pages"

  lifecycle {
    precondition {
      condition     = var.github_pages_owner != ""
      error_message = "github_pages_owner must be set when site_subdomain is used, because the CNAME target is <owner>.github.io."
    }
  }
}
