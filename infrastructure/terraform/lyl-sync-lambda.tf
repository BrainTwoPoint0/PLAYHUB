# ============================================================================
# LYL VEO SYNC LAMBDA + EVENTBRIDGE
# Weekly cron that parses LYL recording titles (rules + Anthropic Haiku
# fallback) and assigns each match to its home + away team folders in Veo.
# ============================================================================
#
# - Reuses the existing `aws_lambda_layer_version.chromium` layer from
#   veo-sync-lambda.tf (Playwright Chromium binary).
# - Reuses `var.supabase_url`, `var.supabase_service_key`, `var.veo_email`,
#   `var.veo_password` from veo-sync-lambda.tf / sync-lambda.tf.
# - New variables: `anthropic_api_key`, `lyl_sync_api_key`,
#   `lyl_share_recipient_email`.
# - Lambda has a Function URL for the admin UI's manual-trigger button
#   (gated by x-api-key against `lyl_sync_api_key`).

variable "anthropic_api_key" {
  description = "Anthropic API key for the LYL sync's title-parser LLM fallback"
  type        = string
  sensitive   = true
}

variable "lyl_sync_api_key" {
  description = "Shared secret protecting the LYL sync Lambda's Function URL (admin-UI manual trigger). Send as x-api-key header."
  type        = string
  sensitive   = true
}

variable "lyl_share_recipient_email" {
  description = "Email Veo share-invitations are sent to (the LYL admin's mailbox). Falls back to var.veo_email when empty."
  type        = string
  default     = ""
}

variable "lyl_report_email" {
  description = "Recipient for the LYL sync's post-run summary email. Falls back to var.alert_email when empty. Set to a distinct LYL-admin mailbox if you want LYL sync emails to land in a different inbox than the existing sync/invoice alerts."
  type        = string
  default     = ""
}

# Resolve at apply time — Terraform substitutes veo_email when the operator
# didn't set lyl_share_recipient_email. Avoids relying on a runtime
# fallback inside the handler (per cloud-infra review: silent fallbacks
# are footguns). Same pattern for lyl_report_email → alert_email.
locals {
  lyl_share_recipient_email_effective = (
    var.lyl_share_recipient_email != "" ? var.lyl_share_recipient_email : var.veo_email
  )
  lyl_report_email_effective = (
    var.lyl_report_email != "" ? var.lyl_report_email : var.alert_email
  )
}

# IAM Role
resource "aws_iam_role" "lyl_sync_lambda" {
  name = "${var.project_name}-lyl-sync-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
  tags = {
    Name        = "PLAYHUB LYL Sync Lambda Role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "lyl_sync_lambda_basic" {
  role       = aws_iam_role.lyl_sync_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "lyl_sync_lambda" {
  name              = "/aws/lambda/${var.project_name}-lyl-sync"
  retention_in_days = 14
  tags = {
    Name        = "PLAYHUB LYL Sync Lambda Logs"
    Environment = var.environment
  }
}

# Lambda function. timeout=600s matches veo-sync (Playwright init + 60+ Veo
# API calls per run for 17+ recordings). memory_size=1536 matches veo-sync
# (Chromium-heavy). Re-uses chromium layer.
resource "aws_lambda_function" "lyl_sync" {
  function_name = "${var.project_name}-lyl-sync"
  role          = aws_iam_role.lyl_sync_lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 600
  memory_size   = 1536

  filename         = "${path.module}/../lambda/lyl-sync/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/lyl-sync/dist.zip")
  layers           = [aws_lambda_layer_version.chromium.arn]

  environment {
    variables = {
      # Server-only Lambda; no NEXT_PUBLIC_ prefix needed (handler reads
      # SUPABASE_URL, with NEXT_PUBLIC_SUPABASE_URL as a fallback for
      # local dev parity with the Next.js app).
      SUPABASE_URL                = var.supabase_url
      SUPABASE_SERVICE_ROLE_KEY   = var.supabase_service_key
      VEO_EMAIL                   = var.veo_email
      VEO_PASSWORD                = var.veo_password
      ANTHROPIC_API_KEY           = var.anthropic_api_key
      LYL_SYNC_API_KEY            = var.lyl_sync_api_key
      LYL_SHARE_RECIPIENT_EMAIL   = local.lyl_share_recipient_email_effective
      LEAGUE_CLUB_SLUG            = "lyl"
      # The Veo clubhouse slug for LYL. Differs from LEAGUE_CLUB_SLUG
      # because our DB uses a short identifier ('lyl') and Veo uses the
      # full club URL slug ('london-youth-league'). The veo-adapter
      # translates at the call boundary using this env var.
      VEO_CLUB_SLUG               = "london-youth-league"
      # Post-run report email — reuses var.resend_api_key already declared
      # in invoicing-lambda.tf (Resend account is per-org, one key for all
      # PLAYHUB Lambdas).
      RESEND_API_KEY              = var.resend_api_key
      LYL_REPORT_EMAIL            = local.lyl_report_email_effective
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lyl_sync_lambda,
    aws_iam_role_policy_attachment.lyl_sync_lambda_basic
  ]

  tags = {
    Name        = "PLAYHUB LYL Veo Recording Sync"
    Environment = var.environment
  }
}

# Disable Lambda's async invocation retries — EventBridge has its own
# retry_policy below, and we don't want duplicate runs from auto-retries
# (the run is idempotent but every call burns LLM tokens for new titles).
resource "aws_lambda_function_event_invoke_config" "lyl_sync" {
  function_name          = aws_lambda_function.lyl_sync.function_name
  maximum_retry_attempts = 0
}

# Function URL — used by the PLAYHUB admin UI to invoke a manual sync run
# or single-recording re-trigger. Auth is x-api-key in the handler (NONE
# at the URL layer so we can return a custom 401 body).
resource "aws_lambda_function_url" "lyl_sync" {
  function_name      = aws_lambda_function.lyl_sync.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = [var.playhub_url]
    allow_methods = ["POST"]
    allow_headers = ["content-type", "x-api-key"]
    max_age       = 86400
  }
}

# Even with authorization_type = NONE, AWS requires an explicit Lambda
# resource-policy statement granting lambda:InvokeFunctionUrl to the
# anonymous principal — otherwise the URL returns 403 Forbidden before
# the handler runs. Discovered 2026-05-17 during smoke test of the
# Function URL — the AuthType=NONE on the URL config alone is necessary
# but NOT sufficient. The `function_url_auth_type` field tells AWS
# which URL auth mode this permission applies to (so it pairs cleanly
# with the URL config above).
resource "aws_lambda_permission" "lyl_sync_url_public" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.lyl_sync.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# EventBridge rule — weekly, Monday 06:00 UTC. Catches everything from the
# weekend's matches at a low-traffic time. Cron format: minute hour ? * day-of-week year
resource "aws_cloudwatch_event_rule" "lyl_sync_schedule" {
  name                = "${var.project_name}-lyl-sync-schedule"
  description         = "Trigger LYL Veo recording sync weekly on Monday 06:00 UTC"
  schedule_expression = "cron(0 6 ? * MON *)"
  tags = {
    Name        = "PLAYHUB LYL Sync Schedule"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "lyl_sync_lambda" {
  rule      = aws_cloudwatch_event_rule.lyl_sync_schedule.name
  target_id = "lyl-sync-cron"
  arn       = aws_lambda_function.lyl_sync.arn
  # No input — cron-triggered runs default to trigger='cron' in the handler.

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "eventbridge_lyl_sync" {
  statement_id  = "AllowEventBridgeLylSync"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lyl_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.lyl_sync_schedule.arn
}

# Duration alarm — fires when a run exceeds 90% of the 600s timeout.
# Catches the "league grew past what fits in 10 minutes" failure mode
# before it becomes a hard timeout. Single-evaluation 24h window matches
# the weekly cadence — one near-timeout per run is one too many.
resource "aws_cloudwatch_metric_alarm" "lyl_sync_lambda_duration" {
  alarm_name          = "${var.project_name}-lyl-sync-lambda-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 86400
  statistic           = "Maximum"
  threshold           = 540000 # 90% of 600s timeout, in milliseconds
  alarm_description   = "LYL sync Lambda run exceeded 90% of its timeout — likely needs more memory or shouldn't be run synchronously soon"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.lyl_sync.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB LYL Sync Duration Alarm"
    Environment = var.environment
  }
}

# Error alarm — fires on any Lambda error in a 1h window. Reuses the
# existing sync_alerts SNS topic (subscribers already set up).
#
# Period was 86400s (24h) originally — that made the alarm stick for
# 24-48h after any single error (CloudWatch's rolling-24h evaluation
# kept including the error datapoint long after the underlying issue
# was fixed). Diagnosed 2026-05-19 when a single May 17 supabase-js
# error kept the alarm in ALARM state for 48h despite zero errors
# since. The Lambda runs hourly (provision-retry) so empty buckets
# are normal — treat_missing_data=notBreaching keeps that quiet.
resource "aws_cloudwatch_metric_alarm" "lyl_sync_lambda_errors" {
  alarm_name          = "${var.project_name}-lyl-sync-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "LYL sync Lambda function failed"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.lyl_sync.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB LYL Sync Error Alarm"
    Environment = var.environment
  }
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "lyl_sync_lambda_arn" {
  value       = aws_lambda_function.lyl_sync.arn
  description = "LYL Sync Lambda function ARN"
}

output "lyl_sync_lambda_name" {
  value       = aws_lambda_function.lyl_sync.function_name
  description = "LYL Sync Lambda function name"
}

output "lyl_sync_function_url" {
  value       = aws_lambda_function_url.lyl_sync.function_url
  description = "Lambda Function URL for admin UI manual-trigger button (x-api-key auth required)"
}

output "lyl_sync_schedule_arn" {
  value       = aws_cloudwatch_event_rule.lyl_sync_schedule.arn
  description = "EventBridge schedule rule ARN for the weekly cron"
}
