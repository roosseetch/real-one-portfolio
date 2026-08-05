variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the R2 buckets."
  type        = string
}

variable "state_bucket_name" {
  description = "Terraform state bucket, shared by every project in this account. Projects are separated by state key prefix, not by bucket."
  type        = string
  default     = "terraform-state"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be 3 to 63 lowercase letters, digits, or hyphens, and may not start or end with a hyphen."
  }
}

variable "manage_state_bucket" {
  description = "Whether this stack creates the state bucket. Set false for a project deploying into an account where it already exists."
  type        = bool
  default     = true
}

variable "r2_location_hint" {
  description = "Optional R2 location hint such as weur or enam. Null lets Cloudflare choose."
  type        = string
  default     = null
}
