# Public custom domains for the two readable buckets. Cloudflare creates and
# proxies the DNS record and terminates TLS, so the site needs no certificate
# handling of its own.
resource "cloudflare_r2_custom_domain" "content" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.content.name
  zone_id     = var.cloudflare_zone_id
  domain      = local.content_hostname
  enabled     = true
  min_tls     = var.min_tls
}

resource "cloudflare_r2_custom_domain" "media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media.name
  zone_id     = var.cloudflare_zone_id
  domain      = local.media_hostname
  enabled     = true
  min_tls     = var.min_tls
}
