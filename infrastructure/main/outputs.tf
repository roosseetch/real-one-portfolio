output "private_bucket_name" {
  description = "Bucket holding drafts and original media."
  value       = cloudflare_r2_bucket.private.name
}

output "content_bucket_name" {
  description = "Bucket holding the published manifest and record chunks."
  value       = cloudflare_r2_bucket.content.name
}

output "media_bucket_name" {
  description = "Bucket holding processed public media."
  value       = cloudflare_r2_bucket.media.name
}

output "content_base_url" {
  description = "Value for the site's CONTENT_BASE_URL build variable."
  value       = "https://${local.content_hostname}"
}

output "media_base_url" {
  description = "Base URL the Worker must use when building public media links."
  value       = "https://${local.media_hostname}"
}

output "site_hostname" {
  description = "Hostname to configure as the GitHub Pages custom domain."
  value       = local.site_hostname
}

output "worker_hostname" {
  description = "Hostname routed to the Worker once worker_enabled is true."
  value       = local.worker_hostname
  sensitive   = true
}

output "turnstile_site_key" {
  description = "Value for the TURNSTILE_SITE_KEY repository variable. Public: the site bundle carries it."
  value       = cloudflare_turnstile_widget.contact.sitekey
}

output "turnstile_secret_key" {
  description = "Value for the TURNSTILE_SECRET_KEY repository secret, which the Worker verifies submissions against. Read it with `terraform output -raw turnstile_secret_key`."
  value       = cloudflare_turnstile_widget.contact.secret
  sensitive   = true
}
