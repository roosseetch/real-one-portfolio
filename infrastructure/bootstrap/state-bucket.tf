locals {
  state_bucket_name = "${var.project_slug}-${var.state_bucket_suffix}"
}

# Holds production/terraform.tfstate for the main stack.
#
# This bucket deliberately has no lifecycle rule and no public custom domain:
# state describes every other resource, so an expiry rule or a public URL here
# would be far more damaging than anywhere else in the system. Back it up
# outside Terraform.
resource "cloudflare_r2_bucket" "state" {
  account_id = var.cloudflare_account_id
  name       = local.state_bucket_name
  location   = var.r2_location_hint
}
