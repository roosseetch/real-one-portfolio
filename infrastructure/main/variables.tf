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

variable "error_log_retention_days" {
  description = "How long the Worker's error logs survive in the private bucket. Longer than drafts: a fault is often only noticed well after the draft that hit it has gone."
  type        = number
  default     = 14

  validation {
    condition     = var.error_log_retention_days >= 1 && var.error_log_retention_days <= 365
    error_message = "error_log_retention_days must be between 1 and 365."
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

variable "site_preview_enabled" {
  description = "Route <site>/activities* through the Worker so a shared ?v= link previews as that activity. Requires worker_enabled, and proxies the site's DNS records, because a Workers route only runs on a hostname Cloudflare proxies."
  type        = bool
  default     = false
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

# Records the transactional email provider asks for, so the domain may send.
#
# Variables rather than literals because both belong to one deployment: the DKIM
# key is minted per domain when it is onboarded, and the bounce host names the
# region that was chosen. Neither is secret — every DKIM public key is readable
# by anyone who can run dig — but a value that is true only of the first person
# to deploy this has no business in a tracked file.

variable "email_dkim_public_key" {
  description = "DKIM public key the email provider issued for this domain, the whole p=... string. Empty leaves the sending records out entirely."
  type        = string
  default     = ""
}

variable "email_bounce_host" {
  description = "Host that receives bounce reports, for example feedback-smtp.<region>.amazonses.com. Region-specific, so it comes from the provider rather than a default."
  type        = string
  default     = ""
}

variable "email_spf_include" {
  description = "The include: mechanism the provider's SPF record needs."
  type        = string
  default     = "amazonses.com"
}

variable "email_dkim_selector" {
  description = "Left-hand label of the DKIM record: <selector>._domainkey.<domain>."
  type        = string
  default     = "resend"
}

variable "email_sending_subdomain" {
  description = "Subdomain the provider sends and receives bounces on."
  type        = string
  default     = "send"
}

variable "email_dmarc_policy" {
  description = "What a receiving server should do with mail that fails DMARC: none, quarantine or reject. `none` is monitoring only, and is what a domain that has just started sending should publish."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.email_dmarc_policy)
    error_message = "email_dmarc_policy must be none, quarantine or reject."
  }
}

variable "email_dmarc_reports_to" {
  description = "Optional address for aggregate DMARC reports. Empty publishes the policy without asking for any."
  type        = string
  default     = ""
}
