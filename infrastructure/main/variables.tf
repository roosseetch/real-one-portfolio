# The account and zone identifiers are marked sensitive so Terraform redacts
# them from plan and apply output. This repository is public, which makes its
# Actions logs public too, and these identifiers appear in R2 endpoint URLs.
variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the R2 buckets and the Worker."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Zone hosting the root domain."
  type        = string
  sensitive   = true
}

variable "project_slug" {
  description = "Lowercase identifier every bucket name is derived from."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.project_slug))
    error_message = "project_slug must be 3 to 32 lowercase letters, digits, or hyphens, and may not start or end with a hyphen."
  }
}

variable "root_domain" {
  description = "Registered domain the public hostnames hang off, for example example.com."
  type        = string
}

variable "content_subdomain" {
  description = "Subdomain serving the public content bucket (manifest and record chunks)."
  type        = string
  default     = "content"
}

variable "media_subdomain" {
  description = "Subdomain serving the public media bucket (processed photos and videos)."
  type        = string
  default     = "media"
}

variable "worker_subdomain" {
  description = "Subdomain routed to the Telegram webhook Worker."
  type        = string
  default     = "worker"
}

variable "site_subdomain" {
  description = "Subdomain for the GitHub Pages site. Empty means serve from the apex."
  type        = string
  default     = ""
}

variable "github_pages_owner" {
  description = "GitHub user or organization owning the Pages site. Required when site_subdomain is set, because the CNAME targets <owner>.github.io."
  type        = string
  default     = ""
}

variable "draft_retention_days" {
  description = "How long drafts and original media survive in the private bucket."
  type        = number
  default     = 7

  validation {
    condition     = var.draft_retention_days >= 1 && var.draft_retention_days <= 30
    error_message = "draft_retention_days must be between 1 and 30."
  }
}

variable "worker_enabled" {
  description = "Attach the Worker custom domain. Leave false until Wrangler has deployed the Worker once, because the domain cannot bind to a script that does not exist yet."
  type        = bool
  default     = false
}

variable "worker_name" {
  description = "Wrangler service name of the deployed Worker. Required when worker_enabled is true."
  type        = string
  default     = ""
}

variable "min_tls" {
  description = "Minimum TLS version for the public R2 custom domains."
  type        = string
  default     = "1.2"
}

variable "r2_location_hint" {
  description = "Optional R2 location hint such as weur or enam. Null lets Cloudflare choose."
  type        = string
  default     = null
}
