locals {
  private_bucket_name = "${var.project_slug}-private"
  content_bucket_name = "${var.project_slug}-content"
  media_bucket_name   = "${var.project_slug}-media"

  content_hostname = "${var.content_subdomain}.${var.root_domain}"
  media_hostname   = "${var.media_subdomain}.${var.root_domain}"
  worker_hostname  = "${var.worker_subdomain}.${var.root_domain}"
  site_hostname    = var.site_subdomain == "" ? var.root_domain : "${var.site_subdomain}.${var.root_domain}"

  serve_site_from_apex = var.site_subdomain == ""

  draft_retention_seconds     = var.draft_retention_days * 24 * 60 * 60
  error_log_retention_seconds = var.error_log_retention_days * 24 * 60 * 60

  # Published by GitHub for Pages custom domains.
  github_pages_ipv4 = [
    "185.199.108.153",
    "185.199.109.153",
    "185.199.110.153",
    "185.199.111.153",
  ]

  github_pages_ipv6 = [
    "2606:50c0:8000::153",
    "2606:50c0:8001::153",
    "2606:50c0:8002::153",
    "2606:50c0:8003::153",
  ]
}
