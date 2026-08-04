output "state_bucket_name" {
  description = "Bucket name to put in the main stack backend configuration."
  value       = cloudflare_r2_bucket.state.name
}

output "state_backend_endpoint" {
  description = "S3-compatible endpoint for the main stack backend."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
  sensitive   = true
}
