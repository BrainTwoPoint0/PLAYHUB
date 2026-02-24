# ============================================================================
# VEO CLUBHOUSE CLEANUP LAMBDA + EVENTBRIDGE
# Removes canceled subscribers from Veo Clubhouse on a daily schedule
# Calls PLAYHUB API endpoint — all logic lives in the app
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
  timeout       = 120
  memory_size   = 128

  filename         = "${path.module}/../lambda/veo-sync/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/veo-sync/dist.zip")

  environment {
    variables = {
      PLAYHUB_URL  = var.playhub_url
      SYNC_API_KEY = var.sync_api_key
      CLUB_SLUGS   = var.veo_sync_club_slugs
      SYNC_MODE    = var.veo_sync_mode
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
}

# Permission for EventBridge to invoke Lambda (cache sync)
resource "aws_lambda_permission" "eventbridge_veo_cache_sync" {
  statement_id  = "AllowEventBridgeCacheSync"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.veo_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.veo_cache_sync_schedule.arn
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
