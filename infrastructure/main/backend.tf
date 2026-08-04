terraform {
  # Deployment-specific settings live in the gitignored backend.private.hcl,
  # created from backend.hcl.example:
  #   terraform init -backend-config=backend.private.hcl
  backend "s3" {}
}
