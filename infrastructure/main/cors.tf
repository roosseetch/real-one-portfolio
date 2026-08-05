# CORS for the public buckets.
#
# The site is served from one hostname and reads its content from another, so
# every fetch the Activity page makes is cross-origin. Without these rules R2
# returns no Access-Control-Allow-Origin header, the browser blocks the
# response, and the page falls back to "Activities are unavailable right now" —
# with the records sitting there, publicly readable, the whole time. curl never
# sees it, because curl does not enforce CORS.
#
# GET and HEAD only. Nothing writes to these buckets from a browser: the Worker
# publishes records with its binding, and GitHub Actions uploads media with
# server-side credentials.

locals {
  # The site origin, and the apex alongside it when the site lives on a
  # subdomain, so a visitor who arrives at either can still load the feed.
  site_origins = distinct([
    "https://${local.site_hostname}",
    "https://${var.root_domain}",
  ])
}

resource "cloudflare_r2_bucket_cors" "content" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.content.name

  rules = [{
    allowed = {
      methods = ["GET", "HEAD"]
      origins = local.site_origins
    }
    # The loader reads bodies, never response headers, so nothing needs
    # exposing beyond the browser-safe defaults.
    max_age_seconds = 3600
  }]
}

resource "cloudflare_r2_bucket_cors" "media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media.name

  rules = [{
    allowed = {
      methods = ["GET", "HEAD"]
      origins = local.site_origins
    }
    max_age_seconds = 3600
  }]
}
