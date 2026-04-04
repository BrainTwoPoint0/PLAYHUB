# ============================================================================
# CLOUDFRONT CDN FOR RECORDINGS
# Serves video recordings via CloudFront with signed URLs.
# Reduces S3 egress costs (~$83/mo → ~$0 with 1TB free tier).
# ============================================================================

# ----------------------------------------------------------------------------
# Variables
# ----------------------------------------------------------------------------

variable "cloudfront_public_key" {
  description = "PEM-encoded RSA public key for CloudFront signed URLs"
  type        = string
}

# ----------------------------------------------------------------------------
# CloudFront Key Pair (for signed URLs)
# ----------------------------------------------------------------------------

resource "aws_cloudfront_public_key" "recordings" {
  name        = "${var.project_name}-recordings-key"
  encoded_key = var.cloudfront_public_key
  comment     = "Key for signing PLAYHUB recording URLs"
}

resource "aws_cloudfront_key_group" "recordings" {
  name    = "${var.project_name}-recordings-key-group"
  items   = [aws_cloudfront_public_key.recordings.id]
  comment = "Key group for PLAYHUB recording signed URLs"
}

# ----------------------------------------------------------------------------
# Origin Access Control (OAC) — lets CloudFront read from private S3 bucket
# ----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "recordings" {
  name                              = "${var.project_name}-recordings-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ----------------------------------------------------------------------------
# CORS Response Headers Policy
# ----------------------------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "cors" {
  name    = "${var.project_name}-cors-policy"
  comment = "CORS for PLAYHUB recording player"

  cors_config {
    access_control_allow_credentials = false

    access_control_allow_headers {
      items = ["*"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }

    access_control_allow_origins {
      items = [
        "https://playhub.playbacksports.ai",
        "http://localhost:3001",
      ]
    }

    access_control_max_age_sec = 86400
    origin_override            = true
  }
}

# ----------------------------------------------------------------------------
# CloudFront Distribution
# ----------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "recordings" {
  enabled         = true
  comment         = "PLAYHUB Recording CDN"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100" # US + Europe edges (cheapest)

  origin {
    domain_name              = aws_s3_bucket.recordings.bucket_regional_domain_name
    origin_id                = "S3-recordings"
    origin_access_control_id = aws_cloudfront_origin_access_control.recordings.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-recordings"
    viewer_protocol_policy = "redirect-to-https"
    compress               = false # Videos are already compressed

    # Managed-CachingOptimized: caches aggressively, ignores query strings.
    # CloudFront auto-strips signed URL params from cache key when
    # trusted_key_groups is set, so the same video is cached once.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    trusted_key_groups = [aws_cloudfront_key_group.recordings.id]

    response_headers_policy_id = aws_cloudfront_response_headers_policy.cors.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name        = "PLAYHUB Recording CDN"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# S3 Bucket Policy — grants CloudFront OAC read access
# ----------------------------------------------------------------------------

resource "aws_s3_bucket_policy" "recordings_cloudfront" {
  bucket = aws_s3_bucket.recordings.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.recordings.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.recordings.arn
          }
        }
      }
    ]
  })
}

# ============================================================================
# S3 ACCESS LOGGING
# ============================================================================

resource "aws_s3_bucket" "recordings_logs" {
  bucket = "${var.s3_bucket}-access-logs"

  tags = {
    Name        = "PLAYHUB Recordings Access Logs"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "recordings_logs" {
  bucket = aws_s3_bucket.recordings_logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_logging" "recordings" {
  bucket        = aws_s3_bucket.recordings.id
  target_bucket = aws_s3_bucket.recordings_logs.id
  target_prefix = "s3-access-logs/"
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "cloudfront_domain_name" {
  value       = aws_cloudfront_distribution.recordings.domain_name
  description = "CloudFront distribution domain name"
}

output "cloudfront_distribution_id" {
  value       = aws_cloudfront_distribution.recordings.id
  description = "CloudFront distribution ID"
}

output "cloudfront_key_pair_id" {
  value       = aws_cloudfront_public_key.recordings.id
  description = "CloudFront key pair ID for signed URLs"
}
