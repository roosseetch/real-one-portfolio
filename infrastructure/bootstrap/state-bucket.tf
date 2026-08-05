# Holds Terraform state for every project in this account, one key prefix each.
#
# The name is deliberately not derived from project_slug. This bucket outlives
# any single project, and a name carrying one project's identity would be wrong
# the moment a second project stored its state beside it. That is also why this
# stack has no project_slug at all: it builds account-level infrastructure, and
# the per-project part lives in the state key rather than the bucket name.
#
# The bucket has no lifecycle rule and no public custom domain, on purpose:
# state describes every other resource, so an expiry rule or a public URL here
# would be far more damaging than anywhere else in the system. Back it up
# outside Terraform.
resource "cloudflare_r2_bucket" "state" {
  # A second project deploying from this template points at the bucket that
  # already exists rather than trying to create it again.
  count = var.manage_state_bucket ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = var.state_bucket_name
  location   = var.r2_location_hint
}
