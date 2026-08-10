# The challenge in front of the contact form.
#
# The Worker's /contact route refuses any submission whose token Cloudflare does
# not recognise, so this widget is what stands between a public endpoint and
# anything that can send an HTTP request. Managed mode: most visitors are let
# through without being asked to do anything, and only a suspicious one sees an
# interactive challenge.
#
# The widget is bound to the site's own hostname. A token issued for another
# domain fails siteverify, which is what stops the form being lifted onto
# somebody else's page and pointed at this Worker.
#
# Terraform owns it because it is account infrastructure like the buckets, and
# because the two halves have to be handed to two different places: the site key
# to a repository variable that the Pages build inlines, and the secret to a
# Worker secret. Both are outputs; neither is written into a tracked file.
resource "cloudflare_turnstile_widget" "contact" {
  account_id = var.cloudflare_account_id
  name       = "${var.project_slug}-contact"
  domains    = [local.site_hostname]
  mode       = "managed"
}
