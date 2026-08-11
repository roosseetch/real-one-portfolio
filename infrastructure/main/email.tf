# The records that let this domain send mail.
#
# The contact form emails a six-digit code to whoever fills it in, and a
# receiving server decides what to do with that mail almost entirely on these
# three records: SPF says which servers may send as this domain, DKIM lets the
# signature on the message be checked, and the MX gives bounces somewhere to go.
# Without them the codes are delivered to spam folders, or not at all, and the
# form fails in the one way nobody reports — silently, for the visitor only.
#
# All three hang off `send.<domain>` and `<selector>._domainkey.<domain>` rather
# than the apex, so they cannot collide with a mail setup on the domain itself.
#
# Unset DKIM means no records at all, not half of them: a domain carrying an SPF
# record that authorises a provider it has no key for is worse than one carrying
# nothing, because it claims something it cannot back up.

locals {
  email_sending_enabled = var.email_dkim_public_key != "" && var.email_bounce_host != ""
  email_sending_host    = "${var.email_sending_subdomain}.${var.root_domain}"

  # An hour, which is what the provider's own setup writes. Not Cloudflare's
  # "auto": these three change roughly never, and a long TTL is what makes a
  # receiving server's cached answer cheap rather than a lookup per message.
  email_record_ttl = 3600
}

# Bounces. Without somewhere to report them the provider cannot tell a dead
# address from a slow one, which is what wrecks a sending reputation over time.
resource "cloudflare_dns_record" "email_bounce_mx" {
  count = local.email_sending_enabled ? 1 : 0

  zone_id  = var.cloudflare_zone_id
  name     = local.email_sending_host
  type     = "MX"
  content  = var.email_bounce_host
  priority = 10
  ttl      = local.email_record_ttl
  comment  = "Transactional email: bounce reports"
}

resource "cloudflare_dns_record" "email_spf" {
  count = local.email_sending_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = local.email_sending_host
  type    = "TXT"
  # ~all rather than -all: a soft fail. The provider's own record, and the
  # cautious end of it — a hard fail on a subdomain that has only just started
  # sending turns every misconfiguration into a bounce instead of a spam folder.
  content = "\"v=spf1 include:${var.email_spf_include} ~all\""
  ttl     = local.email_record_ttl
  comment = "Transactional email: SPF"
}

# DMARC, which is what ties the other two together.
#
# SPF and DKIM each say something narrow; DMARC is the record that tells a
# receiving server what to conclude when they disagree, and — since Gmail and
# Yahoo tightened their sender rules in 2024 — its absence is itself a reason to
# treat mail as suspicious. A verification code that lands in a spam folder is
# the worst failure this form has, because the visitor sees a form that appears
# to work and never learns why nothing arrived. This site's first code went to
# spam for exactly this reason.
#
# `p=none` is monitoring only: it asks nobody to reject anything, which is the
# right setting for a domain that has just started sending and has no
# reputation. Tightening it later is a variable, not a code change.
resource "cloudflare_dns_record" "email_dmarc" {
  count = local.email_sending_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.root_domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=${var.email_dmarc_policy};${var.email_dmarc_reports_to == "" ? "" : " rua=mailto:${var.email_dmarc_reports_to};"}\""
  ttl     = local.email_record_ttl
  comment = "Transactional email: DMARC"
}

resource "cloudflare_dns_record" "email_dkim" {
  count = local.email_sending_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "${var.email_dkim_selector}._domainkey.${var.root_domain}"
  type    = "TXT"
  content = "\"${var.email_dkim_public_key}\""
  ttl     = local.email_record_ttl
  comment = "Transactional email: DKIM"
}
