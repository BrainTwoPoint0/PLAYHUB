# ============================================================================
# S3 RECORDINGS BUCKET
# Stores Spiideo recordings synced by the sync-recordings Lambda.
# Imported into Terraform state on 2026-03-01.
# ============================================================================

resource "aws_s3_bucket" "recordings" {
  bucket = var.s3_bucket

  tags = {
    Name        = "PLAYHUB Recordings"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# Disable versioning — recordings have source-of-truth in Spiideo.
# Versioning wastes storage on any re-synced files.
# ----------------------------------------------------------------------------

resource "aws_s3_bucket_versioning" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  versioning_configuration {
    status = "Suspended"
  }
}

# ----------------------------------------------------------------------------
# Lifecycle policy — tiered storage to reduce costs by ~70% over 3 years.
#
# Timeline:
#   0-30 days   → S3 Standard ($0.023/GB/mo)  — hot access for recent recordings
#   30-90 days  → Intelligent-Tiering          — auto-moves infrequent to cheaper tier
#   90-365 days → Glacier Instant Retrieval    — 83% cheaper, millisecond access
#   365+ days   → Glacier Flexible Retrieval   — 84% cheaper, 3-5 hour retrieval
#
# Recordings rest at Glacier Instant Retrieval from day 90 — still
# millisecond GetObject, so signed playback URLs keep working forever.
# (A previous 365-day Glacier Flexible tier was removed 2026-06-13: it made
# objects unreadable via plain signed GETs — InvalidObjectState — which
# breaks Clutch rally-clip browsing and match playback for year-old
# recordings the UI still lists. The storage saving was ~$0.0004/GB/mo.)
# ----------------------------------------------------------------------------

resource "aws_s3_bucket_lifecycle_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  rule {
    id     = "tiered-storage"
    status = "Enabled"

    filter {
      prefix = "recordings/"
    }

    # After 30 days: move to Intelligent-Tiering (auto-optimizes access patterns)
    transition {
      days          = 30
      storage_class = "INTELLIGENT_TIERING"
    }

    # After 90 days: move to Glacier Instant Retrieval (83% cheaper, ms access)
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
  }

  # Clean up incomplete multipart uploads after 1 day.
  # The sync Lambda is the only writer; a MPU still in-flight after
  # Lambda has timed out will never resume — the next invocation
  # creates a fresh MPU with a new UploadId. Keeping dead parts around
  # longer just burns storage cost.
  rule {
    id     = "cleanup-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
