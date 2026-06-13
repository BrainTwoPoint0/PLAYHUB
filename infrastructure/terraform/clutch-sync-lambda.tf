# ============================================================================
# CLUTCH SYNC LAMBDA + EVENTBRIDGE
# Syncs Clutch (padel camera) recordings to S3 every 15 minutes.
# Provider-isolated clone of sync-lambda.tf; alarms reuse the existing
# sync_alerts SNS topic so all recording-sync alerts land in one inbox.
# ============================================================================

variable "clutch_email" {
  description = "Clutch account email (API auth is the account login)"
  type        = string
}

variable "clutch_password" {
  description = "Clutch account password"
  type        = string
  sensitive   = true
}

# IAM Role for Clutch Sync Lambda
resource "aws_iam_role" "clutch_sync_lambda" {
  name = "${var.project_name}-clutch-sync-lambda-role"

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
    Name        = "PLAYHUB Clutch Sync Lambda Role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "clutch_sync_lambda_basic" {
  role       = aws_iam_role.clutch_sync_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# S3 permissions for uploading recordings
resource "aws_iam_role_policy" "clutch_sync_lambda_s3" {
  name = "${var.project_name}-clutch-sync-lambda-s3"
  role = aws_iam_role.clutch_sync_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:HeadObject",
          "s3:GetObject"
        ]
        Resource = "arn:aws:s3:::${var.s3_bucket}/*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "clutch_sync_lambda" {
  name              = "/aws/lambda/${var.project_name}-clutch-sync"
  retention_in_days = 14

  tags = {
    Name        = "PLAYHUB Clutch Sync Lambda Logs"
    Environment = var.environment
  }
}

resource "aws_lambda_function" "clutch_sync" {
  function_name = "${var.project_name}-clutch-sync"
  role          = aws_iam_role.clutch_sync_lambda.arn
  handler       = "index.handler"
  # nodejs22.x (not 20 like the siblings): supabase-js ≥2.48 requires native
  # WebSocket at client construction, which Lambda only ships from Node 22.
  runtime       = "nodejs22.x"
  timeout       = 900  # 15 minutes (max for Lambda)
  memory_size   = 1024 # 1GB for streaming large video files

  # No reserved concurrency for the same account-quota reason as
  # sync_recordings (see sync-lambda.tf). Overlapping runs are benign:
  # the handler HeadObjects S3 keys before uploading and the publish
  # update is idempotent.

  filename         = "${path.module}/../lambda/clutch-sync/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/clutch-sync/dist.zip")

  environment {
    variables = {
      CLUTCH_EMAIL         = var.clutch_email
      CLUTCH_PASSWORD      = var.clutch_password
      S3_BUCKET            = var.s3_bucket
      S3_REGION            = var.aws_region
      SUPABASE_URL         = var.supabase_url
      SUPABASE_SERVICE_KEY = var.supabase_service_key
      RESEND_API_KEY       = var.resend_api_key
      ALERT_EMAIL          = var.alert_email
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.clutch_sync_lambda,
    aws_iam_role_policy_attachment.clutch_sync_lambda_basic
  ]

  tags = {
    Name        = "PLAYHUB Clutch Sync"
    Environment = var.environment
  }
}

# EventBridge Rule - trigger every 15 minutes
resource "aws_cloudwatch_event_rule" "clutch_sync_schedule" {
  name                = "${var.project_name}-clutch-sync-schedule"
  description         = "Trigger Clutch recording sync every 15 minutes"
  schedule_expression = "rate(15 minutes)"

  tags = {
    Name        = "PLAYHUB Clutch Sync Schedule"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "clutch_sync_lambda" {
  rule      = aws_cloudwatch_event_rule.clutch_sync_schedule.name
  target_id = "clutch-sync-lambda"
  arn       = aws_lambda_function.clutch_sync.arn
}

resource "aws_lambda_permission" "eventbridge_clutch_sync" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.clutch_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.clutch_sync_schedule.arn
}

# ============================================================================
# ALARMS (reuse aws_sns_topic.sync_alerts from sync-lambda.tf)
# ============================================================================

resource "aws_cloudwatch_metric_alarm" "clutch_sync_lambda_errors" {
  alarm_name          = "${var.project_name}-clutch-sync-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Clutch sync Lambda function failed"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.clutch_sync.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Clutch Sync Error Alarm"
    Environment = var.environment
  }
}

# Zero-invocations alarm — catches the EventBridge rule being disabled or
# deleted. Lambda publishes NO Invocations datapoint for idle periods (the
# metric goes missing, it doesn't go to zero), so missing data must be
# treated as breaching or the alarm parks in INSUFFICIENT_DATA and never
# notifies. Expect one page right after first deploy until the first tick.
resource "aws_cloudwatch_metric_alarm" "clutch_sync_lambda_no_invocations" {
  alarm_name          = "${var.project_name}-clutch-sync-lambda-no-invocations"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Clutch sync Lambda has not been invoked for 30 minutes — EventBridge rule may be disabled or deleted"
  treat_missing_data  = "breaching"

  dimensions = {
    FunctionName = aws_lambda_function.clutch_sync.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Clutch Sync No-Invocations Alarm"
    Environment = var.environment
  }
}

# Duration alarm — sequential row processing inside a 900s timeout can
# silently truncate runs once a backlog builds; warn before the cliff.
resource "aws_cloudwatch_metric_alarm" "clutch_sync_lambda_timeout" {
  alarm_name          = "${var.project_name}-clutch-sync-lambda-timeout"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Maximum"
  threshold           = 810000 # 13.5 minutes in ms (warning before 15 min timeout)
  alarm_description   = "Clutch sync Lambda approaching timeout limit"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.clutch_sync.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Clutch Sync Timeout Alarm"
    Environment = var.environment
  }
}

# Row-level errors alarm — the handler catches per-row failures (the function
# still returns 200, so AWS/Lambda Errors stays 0) and emits this EMF metric
# instead. Two consecutive non-zero runs = something is persistently broken.
resource "aws_cloudwatch_metric_alarm" "clutch_sync_row_errors" {
  alarm_name          = "${var.project_name}-clutch-sync-row-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "PLAYHUB/ClutchSync"
  period              = 900
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Clutch sync rows are erroring for 30+ minutes — credentials, Clutch API, or a stuck recording"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Clutch Sync Row Errors Alarm"
    Environment = var.environment
  }
}

# Asset-errors alarm — clip/crop mirrors are best-effort: a published row
# leaves the sync queue even if some highlight assets failed, so without
# this a systematic clip-CDN failure would silently produce matches with
# empty highlight indexes.
resource "aws_cloudwatch_metric_alarm" "clutch_sync_asset_errors" {
  alarm_name          = "${var.project_name}-clutch-sync-asset-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "AssetErrors"
  namespace           = "PLAYHUB/ClutchSync"
  period              = 900
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Clutch highlight/crop mirrors failing for 30+ minutes — clips may be missing from published recordings"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Clutch Sync Asset Errors Alarm"
    Environment = var.environment
  }
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "clutch_sync_lambda_name" {
  value       = aws_lambda_function.clutch_sync.function_name
  description = "Clutch sync Lambda function name"
}
