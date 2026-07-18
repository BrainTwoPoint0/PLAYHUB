# ============================================================================
# NETLIFY RUNTIME IAM USER
# Scoped credentials for PLAYHUB Next.js functions running on Netlify.
# Replaces the previous use of playhub-admin (which had S3/IAM full access).
# ============================================================================

resource "aws_iam_user" "netlify" {
  name = "playhub-netlify"

  tags = {
    Purpose     = "Netlify runtime credentials for PLAYHUB Next.js functions"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# S3 access: recordings read/write + CloudFront key read
# ----------------------------------------------------------------------------

resource "aws_iam_user_policy" "netlify_s3" {
  name = "playhub-netlify-s3"
  user = aws_iam_user.netlify.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RecordingsReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ]
        Resource = "${aws_s3_bucket.recordings.arn}/recordings/*"
      },
      {
        # Pitch-calibration stills (median frames from the raw panorama,
        # written by the player-tracklets Batch job). The app lists +
        # presigns them for the marking UI, and DELETES a scene's stills
        # when the scene is unassigned/reassigned to another org (they are
        # derived from the old org's footage — cross-tenant otherwise).
        # Never PutObject: only the Batch job renders stills.
        Sid    = "CalibrationStills"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.recordings.arn}/calibration-stills/*"
      },
      {
        Sid      = "CloudFrontKeyRead"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.recordings.arn}/keys/cloudfront-private-key.pem"
      },
      {
        Sid      = "BucketList"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.recordings.arn
        Condition = {
          StringLike = {
            "s3:prefix" = ["recordings/*", "keys/*", "calibration-stills/*"]
          }
        }
      },
    ]
  })
}

# ----------------------------------------------------------------------------
# MediaLive + MediaPackage: manage live streaming channels
# ----------------------------------------------------------------------------

resource "aws_iam_user_policy" "netlify_medialive" {
  name = "playhub-netlify-medialive"
  user = aws_iam_user.netlify.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "MediaLiveChannels"
        Effect = "Allow"
        Action = [
          "medialive:DescribeChannel",
          "medialive:ListChannels",
          "medialive:StartChannel",
          "medialive:StopChannel",
          "medialive:CreateChannel",
          "medialive:DeleteChannel",
          "medialive:DescribeInput",
          "medialive:ListInputs",
          "medialive:CreateInput",
          "medialive:DeleteInput",
        ]
        Resource = "*"
      },
      {
        Sid    = "MediaPackageRead"
        Effect = "Allow"
        Action = [
          "mediapackage:DescribeChannel",
          "mediapackage:ListChannels",
          "mediapackage:DescribeOriginEndpoint",
          "mediapackage:ListOriginEndpoints",
        ]
        Resource = "*"
      },
      {
        Sid      = "PassMediaLiveRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = "*"
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "medialive.amazonaws.com"
          }
        }
      },
    ]
  })
}

# ----------------------------------------------------------------------------
# Lambda invoke: PLAYHUB Next.js routes call AWS SDK to async-invoke
# background Lambdas. Currently used by the Academy → Sync Now flow
# (cache-sync, cleanup-sync, privacy-sync — all dispatched via the
# playhub-veo-sync Lambda's `action` payload field).
#
# Add new ARNs here as routes start invoking other Lambdas. The LYL
# sync Lambda is intentionally NOT here — it uses a Function URL with
# x-api-key auth, not SDK invocation, so it doesn't need IAM permissions.
# ----------------------------------------------------------------------------

resource "aws_iam_user_policy" "netlify_lambda" {
  name = "playhub-netlify-lambda"
  user = aws_iam_user.netlify.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeBackgroundLambdas"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = [
          aws_lambda_function.veo_sync.arn,
        ]
      },
    ]
  })
}

# ----------------------------------------------------------------------------
# Access key for Netlify env vars
# ----------------------------------------------------------------------------

resource "aws_iam_access_key" "netlify" {
  user = aws_iam_user.netlify.name
}

output "netlify_access_key_id" {
  value       = aws_iam_access_key.netlify.id
  sensitive   = true
  description = "Access key ID for Netlify runtime IAM user"
}

output "netlify_secret_access_key" {
  value       = aws_iam_access_key.netlify.secret
  sensitive   = true
  description = "Secret access key for Netlify runtime IAM user"
}
