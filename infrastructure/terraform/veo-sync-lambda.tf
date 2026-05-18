# ============================================================================
# VEO CLUBHOUSE SYNC LAMBDA + EVENTBRIDGE
# cache-sync: Scrapes Veo directly via Playwright + writes to Supabase
# cleanup-sync: Calls PLAYHUB API to remove canceled subscribers
# ============================================================================

variable "playhub_url" {
  description = "PLAYHUB base URL (e.g. https://playhub.playbacksports.ai)"
  type        = string
}

variable "sync_api_key" {
  description = "API key for the /veo/sync endpoint"
  type        = string
  sensitive   = true
}

variable "veo_sync_club_slugs" {
  description = "Comma-separated club slugs to sync"
  type        = string
  default     = "cfa,sefa"
}

variable "veo_sync_mode" {
  description = "Sync mode: dry-run or execute"
  type        = string
  default     = "dry-run"
}

variable "veo_email" {
  description = "Veo account email for Playwright login"
  type        = string
  sensitive   = true
}

variable "veo_password" {
  description = "Veo account password for Playwright login"
  type        = string
  sensitive   = true
}

# NOTE: supabase_url and supabase_service_key are declared in sync-lambda.tf

# Chromium Lambda Layer — uploaded to S3 (too large for direct upload)
# Contains @sparticuz/chromium binary (~59MB). Function zip has playwright-core only (~2.5MB).
resource "aws_lambda_layer_version" "chromium" {
  s3_bucket           = var.s3_bucket
  s3_key              = "lambda/chromium-layer.zip"
  layer_name          = "${var.project_name}-chromium"
  compatible_runtimes = ["nodejs20.x"]
  description         = "Chromium binary for Playwright (from @sparticuz/chromium)"
}

# IAM Role for Veo Sync Lambda
resource "aws_iam_role" "veo_sync_lambda" {
  name = "${var.project_name}-veo-sync-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "PLAYHUB Veo Sync Lambda Role"
    Environment = var.environment
  }
}

# Basic Lambda execution policy (CloudWatch Logs)
resource "aws_iam_role_policy_attachment" "veo_sync_lambda_basic" {
  role       = aws_iam_role.veo_sync_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "veo_sync_lambda" {
  name              = "/aws/lambda/${var.project_name}-veo-sync"
  retention_in_days = 14

  tags = {
    Name        = "PLAYHUB Veo Sync Lambda Logs"
    Environment = var.environment
  }
}

# Lambda Function
resource "aws_lambda_function" "veo_sync" {
  function_name = "${var.project_name}-veo-sync"
  role          = aws_iam_role.veo_sync_lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 600
  memory_size   = 1536

  filename         = "${path.module}/../lambda/veo-sync/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/veo-sync/dist.zip")
  layers           = [aws_lambda_layer_version.chromium.arn]

  environment {
    variables = {
      PLAYHUB_URL              = var.playhub_url
      SYNC_API_KEY             = var.sync_api_key
      CLUB_SLUGS               = var.veo_sync_club_slugs
      SYNC_MODE                = var.veo_sync_mode
      VEO_EMAIL                = var.veo_email
      VEO_PASSWORD             = var.veo_password
      SUPABASE_URL             = var.supabase_url
      SUPABASE_SERVICE_ROLE_KEY = var.supabase_service_key
      LAMBDA_TIMEOUT           = "600"
      # Used by the `invite-member` action handler to email
      # admin@playbacksports.ai when a Veo invite fails for a paying
      # customer. var.resend_api_key is already declared in invoicing-lambda.tf.
      RESEND_API_KEY           = var.resend_api_key
      ADMIN_ALERT_EMAIL        = var.alert_email
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.veo_sync_lambda,
    aws_iam_role_policy_attachment.veo_sync_lambda_basic
  ]

  tags = {
    Name        = "PLAYHUB Veo Clubhouse Sync"
    Environment = var.environment
  }
}

# EventBridge Rule — daily at 8am UTC
resource "aws_cloudwatch_event_rule" "veo_sync_schedule" {
  name                = "${var.project_name}-veo-sync-schedule"
  description         = "Trigger Veo Clubhouse cleanup daily at 8am UTC"
  schedule_expression = "cron(0 8 * * ? *)"

  tags = {
    Name        = "PLAYHUB Veo Sync Schedule"
    Environment = var.environment
  }
}

# EventBridge Target — cleanup sync (daily)
resource "aws_cloudwatch_event_target" "veo_sync_lambda" {
  rule      = aws_cloudwatch_event_rule.veo_sync_schedule.name
  target_id = "veo-cleanup-sync"
  arn       = aws_lambda_function.veo_sync.arn
  input     = jsonencode({ action = "cleanup-sync" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

# Permission for EventBridge to invoke Lambda (cleanup)
resource "aws_lambda_permission" "eventbridge_veo_sync" {
  statement_id  = "AllowEventBridgeCleanupSync"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.veo_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.veo_sync_schedule.arn
}

# EventBridge Rule — cache sync every 4 hours
resource "aws_cloudwatch_event_rule" "veo_cache_sync_schedule" {
  name                = "${var.project_name}-veo-cache-sync-schedule"
  description         = "Refresh Veo ClubHouse data cache every 4 hours"
  schedule_expression = "rate(4 hours)"

  tags = {
    Name        = "PLAYHUB Veo Cache Sync Schedule"
    Environment = var.environment
  }
}

# EventBridge Target — cache sync (every 4 hours)
resource "aws_cloudwatch_event_target" "veo_cache_sync_lambda" {
  rule      = aws_cloudwatch_event_rule.veo_cache_sync_schedule.name
  target_id = "veo-cache-sync"
  arn       = aws_lambda_function.veo_sync.arn
  input     = jsonencode({ action = "cache-sync" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

# Permission for EventBridge to invoke Lambda (cache sync)
resource "aws_lambda_permission" "eventbridge_veo_cache_sync" {
  statement_id  = "AllowEventBridgeCacheSync"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.veo_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.veo_cache_sync_schedule.arn
}

# EventBridge Rule — content precache every 2 hours (offset from cache-sync)
resource "aws_cloudwatch_event_rule" "veo_content_precache_schedule" {
  name                = "${var.project_name}-veo-content-precache-schedule"
  description         = "Pre-cache Veo match content (videos/highlights/stats) every 4 hours"
  schedule_expression = "rate(4 hours)"

  tags = {
    Name        = "PLAYHUB Veo Content Precache Schedule"
    Environment = var.environment
  }
}

# EventBridge Target — content precache (every 2 hours at :30)
resource "aws_cloudwatch_event_target" "veo_content_precache_lambda" {
  rule      = aws_cloudwatch_event_rule.veo_content_precache_schedule.name
  target_id = "veo-content-precache"
  arn       = aws_lambda_function.veo_sync.arn
  input     = jsonencode({ action = "content-precache" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

# Permission for EventBridge to invoke Lambda (content precache)
resource "aws_lambda_permission" "eventbridge_veo_content_precache" {
  statement_id  = "AllowEventBridgeContentPrecache"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.veo_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.veo_content_precache_schedule.arn
}

# Dead Letter Queue for async invocations that crash before completion.
# Defense-in-depth on top of the hourly sweep + failure email + attempt
# ceiling — catches Lambda cold-start failures / throttle events within
# seconds rather than the sweep's 1-hour worst-case latency.
#
# IAM for the DLQ lives outside Terraform on the `playhub-admin` deploy
# user (inline policy `veo-sync-dlq-management` scoped to the DLQ ARN).
# Granted via AWS CLI on 2026-05-17. If you ever rename the queue, also
# update that inline policy's Resource ARN to match.
#
# Kept as a variable so a future destroy / restage can toggle without
# editing every dependent resource's count expression.
variable "enable_veo_sync_dlq" {
  description = "When true (default), provisions the veo-sync DLQ + alarm + Lambda destination_config wiring. Set false only for tear-down."
  type        = bool
  default     = true
}

resource "aws_sqs_queue" "veo_sync_dlq" {
  count                      = var.enable_veo_sync_dlq ? 1 : 0
  name                       = "${var.project_name}-veo-sync-dlq"
  message_retention_seconds  = 1209600 # 14 days — max
  visibility_timeout_seconds = 60

  tags = {
    Name        = "PLAYHUB Veo Sync DLQ"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy" "veo_sync_lambda_dlq" {
  count = var.enable_veo_sync_dlq ? 1 : 0
  name  = "${var.project_name}-veo-sync-lambda-dlq"
  role  = aws_iam_role.veo_sync_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "WriteToDeadLetterQueue"
      Effect   = "Allow"
      Action   = "sqs:SendMessage"
      Resource = aws_sqs_queue.veo_sync_dlq[0].arn
    }]
  })
}

# Disable Lambda's own async invocation retries (EventBridge retry_policy handles
# EventBridge-triggered retries, but this covers manual async invocations too).
# Route async-invoke failures to the DLQ when var.enable_veo_sync_dlq is set —
# gated behind a `length()` check so the resource still applies cleanly when
# the queue isn't provisioned (var=false).
resource "aws_lambda_function_event_invoke_config" "veo_sync" {
  function_name          = aws_lambda_function.veo_sync.function_name
  maximum_retry_attempts = 0

  dynamic "destination_config" {
    for_each = length(aws_sqs_queue.veo_sync_dlq) > 0 ? [1] : []
    content {
      on_failure {
        destination = aws_sqs_queue.veo_sync_dlq[0].arn
      }
    }
  }
}

# Alarm if anything lands in the DLQ — paying customer may be unprovisioned.
resource "aws_cloudwatch_metric_alarm" "veo_sync_dlq_not_empty" {
  count               = var.enable_veo_sync_dlq ? 1 : 0
  alarm_name          = "${var.project_name}-veo-sync-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "veo-sync Lambda async invocation failed and landed in DLQ — paying customer may be unprovisioned"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.veo_sync_dlq[0].name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Veo Sync DLQ Alarm"
    Environment = var.environment
  }
}

# ============================================================================
# PROVISION-RETRY SWEEP — defensive hourly sweep for any academy_subscriptions
# row that's active+unprovisioned for >5min. Catches lost events from the
# Stripe-webhook → Lambda async-dispatch path. See invite-member.ts.
# ============================================================================

resource "aws_cloudwatch_event_rule" "veo_sync_provision_retry_schedule" {
  name                = "${var.project_name}-veo-sync-provision-retry-schedule"
  description         = "Trigger veo-sync Lambda's provision-retry sweep hourly"
  schedule_expression = "rate(1 hour)"
  tags = {
    Name        = "PLAYHUB Provision-Retry Sweep Schedule"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "veo_sync_provision_retry_target" {
  rule      = aws_cloudwatch_event_rule.veo_sync_provision_retry_schedule.name
  target_id = "veo-sync-provision-retry"
  arn       = aws_lambda_function.veo_sync.arn
  input     = jsonencode({ action = "provision-retry" })

  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "eventbridge_veo_sync_provision_retry" {
  statement_id  = "AllowEventBridgeProvisionRetry"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.veo_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.veo_sync_provision_retry_schedule.arn
}

# Reuse existing SNS topic for alerts
resource "aws_cloudwatch_metric_alarm" "veo_sync_lambda_errors" {
  alarm_name          = "${var.project_name}-veo-sync-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 86400
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Veo sync Lambda function failed"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.veo_sync.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Veo Sync Error Alarm"
    Environment = var.environment
  }
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "veo_sync_lambda_arn" {
  value       = aws_lambda_function.veo_sync.arn
  description = "Veo Sync Lambda function ARN"
}

output "veo_sync_lambda_name" {
  value       = aws_lambda_function.veo_sync.function_name
  description = "Veo Sync Lambda function name"
}

output "veo_sync_schedule_arn" {
  value       = aws_cloudwatch_event_rule.veo_sync_schedule.arn
  description = "Veo cleanup sync EventBridge schedule rule ARN"
}

output "veo_cache_sync_schedule_arn" {
  value       = aws_cloudwatch_event_rule.veo_cache_sync_schedule.arn
  description = "Veo cache sync EventBridge schedule rule ARN"
}

output "veo_content_precache_schedule_arn" {
  value       = aws_cloudwatch_event_rule.veo_content_precache_schedule.arn
  description = "Veo content precache EventBridge schedule rule ARN"
}


