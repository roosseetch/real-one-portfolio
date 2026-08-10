# Custom domain for the Telegram webhook Worker.
#
# Wrangler owns the Worker itself: the script, its R2 and Workers AI bindings,
# the compatibility date, its cron trigger, and its secrets. Terraform only
# routes a hostname to it, which means the script has to exist first. Keep
# worker_enabled false until the deploy-worker workflow has run once, then flip
# it on.
#
# There is deliberately no cloudflare_workers_cron_trigger here, and adding one
# would be a mistake rather than an omission. The schedule is declared in
# worker/wrangler.template.json next to the handler it invokes, so one deploy
# ships both; a copy in Terraform would be a second writer of the same field,
# and whichever ran last would win. The reasoning is written out in full at that
# "//triggers" key.
#
# Cloudflare terminates TLS for this hostname, so no certificate handling is
# needed here either.
resource "cloudflare_workers_custom_domain" "worker" {
  count = var.worker_enabled ? 1 : 0

  account_id  = var.cloudflare_account_id
  zone_id     = var.cloudflare_zone_id
  hostname    = local.worker_hostname
  service     = var.worker_name
  environment = "production"

  lifecycle {
    precondition {
      condition     = var.worker_name != ""
      error_message = "worker_name must be set when worker_enabled is true; it has to match the Wrangler service name."
    }
  }
}
