# The publisher writes Cache-Control on every object: record chunks are
# immutable and cached for a year, the manifest is revalidated. This rule makes
# the edge honor those headers on both public hostnames, so a zone-wide cache
# setting cannot quietly serve a stale manifest.
resource "cloudflare_ruleset" "public_cache" {
  zone_id = var.cloudflare_zone_id
  name    = "${var.project_slug} public cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules = [
    {
      ref         = "respect_origin_cache_control"
      description = "Respect Cache-Control written by the publisher"
      expression  = "(http.host eq \"${local.content_hostname}\") or (http.host eq \"${local.media_hostname}\")"
      action      = "set_cache_settings"
      enabled     = true

      action_parameters = {
        cache                = true
        origin_cache_control = true

        edge_ttl = {
          mode = "respect_origin"
        }

        browser_ttl = {
          mode = "respect_origin"
        }
      }
    },
  ]
}
