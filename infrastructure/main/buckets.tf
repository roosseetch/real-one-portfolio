# Drafts and original media. Never publicly readable and never given a custom
# domain: everything here is either unapproved or unsanitized.
resource "cloudflare_r2_bucket" "private" {
  account_id = var.cloudflare_account_id
  name       = local.private_bucket_name
  location   = var.r2_location_hint
}

# Published record chunks and the manifest the static site reads.
resource "cloudflare_r2_bucket" "content" {
  account_id = var.cloudflare_account_id
  name       = local.content_bucket_name
  location   = var.r2_location_hint
}

# Processed media derivatives, written only after metadata sanitization.
resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = local.media_bucket_name
  location   = var.r2_location_hint
}
