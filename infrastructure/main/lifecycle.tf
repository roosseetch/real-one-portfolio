# Drafts and originals expire on their own so unapproved content and
# unsanitized media cannot linger. Published records and processed media are in
# other buckets and are never touched by these rules.
resource "cloudflare_r2_bucket_lifecycle" "private" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.private.name

  rules = [
    {
      id      = "expire-drafts"
      enabled = true

      conditions = {
        prefix = "drafts/"
      }

      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = local.draft_retention_seconds
        }
      }

      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 86400
        }
      }
    },
    # The Worker's own error logs. Kept longer than drafts because a fault is
    # usually noticed after the fact, but still swept up: nothing here is worth
    # storing forever, and an unbounded prefix is how a private bucket grows
    # without anyone deciding that it should.
    {
      id      = "expire-error-logs"
      enabled = true

      conditions = {
        prefix = "logs/"
      }

      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = local.error_log_retention_seconds
        }
      }

      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 86400
        }
      }
    },
    # Messages sent through the contact form, and the per-address slots that
    # throttle it. Both exist only to get a message across the gap between the
    # Worker and the job that checks it: once it has reached Telegram there is
    # no reason to keep a stranger's message and address in a bucket, so it goes
    # on the same clock as an unapproved draft.
    {
      id      = "expire-contact"
      enabled = true

      conditions = {
        prefix = "contact/"
      }

      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = local.draft_retention_seconds
        }
      }

      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 86400
        }
      }
    },
    {
      id      = "expire-originals"
      enabled = true

      conditions = {
        prefix = "originals/"
      }

      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = local.draft_retention_seconds
        }
      }

      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 86400
        }
      }
    },
  ]
}
