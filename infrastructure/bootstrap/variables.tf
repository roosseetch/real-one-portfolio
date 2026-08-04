variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the R2 buckets."
  type        = string
}

variable "project_slug" {
  description = "Lowercase identifier every resource name is derived from."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.project_slug))
    error_message = "project_slug must be 3 to 32 lowercase letters, digits, or hyphens, and may not start or end with a hyphen."
  }
}

variable "state_bucket_suffix" {
  description = "Suffix appended to project_slug to name the Terraform state bucket."
  type        = string
  default     = "tf-state"
}

variable "r2_location_hint" {
  description = "Optional R2 location hint such as weur or enam. Null lets Cloudflare choose."
  type        = string
  default     = null
}
