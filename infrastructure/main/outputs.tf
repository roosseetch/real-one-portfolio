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
