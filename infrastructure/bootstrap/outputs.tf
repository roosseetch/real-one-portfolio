output "state_bucket_name" {
  description = "Bucket name to put in the main stack backend configuration."
  # Read from the variable rather than the resource so the output still answers
  # when manage_state_bucket is false and there is no resource to read.
  value = var.state_bucket_name
}

output "state_backend_endpoint" {
  description = "S3-compatible endpoint for the main stack backend."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
  sensitive   = true
}
