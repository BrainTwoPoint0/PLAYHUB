# ============================================================================
# RECORDING SYNC LAMBDA + EVENTBRIDGE
# Automatically syncs Spiideo recordings to S3 every 15 minutes
# ============================================================================

# Variables for sync configuration
variable "spiideo_client_id" {
  description = "Spiideo OAuth client ID"
  type        = string
}

variable "spiideo_client_secret" {
  description = "Spiideo OAuth client secret"
  type        = string
  sensitive   = true
}

variable "spiideo_account_id" {
  description = "Spiideo account ID"
  type        = string
}

variable "spiideo_user_id" {
  description = "Spiideo user ID for API requests"
  type        = string
}

variable "s3_bucket" {
  description = "S3 bucket for storing recordings"
  type        = string
}

variable "supabase_url" {
  description = "Supabase project URL"
  type        = string
}

variable "supabase_service_key" {
  description = "Supabase service role key (bypasses RLS)"
  type        = string
  sensitive   = true
}

variable "alert_email" {
  description = "Email address for Lambda failure alerts"
  type        = string
  default     = ""
}

# IAM Role for Sync Lambda
resource "aws_iam_role" "sync_lambda" {
  name = "${var.project_name}-sync-lambda-role"

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
    Name        = "PLAYHUB Sync Lambda Role"
    Environment = var.environment
  }
}

# Basic Lambda execution policy (CloudWatch Logs)
resource "aws_iam_role_policy_attachment" "sync_lambda_basic" {
  role       = aws_iam_role.sync_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# S3 permissions for uploading recordings
resource "aws_iam_role_policy" "sync_lambda_s3" {
  name = "${var.project_name}-sync-lambda-s3"
  role = aws_iam_role.sync_lambda.id

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

# CloudWatch Log Group for Lambda
resource "aws_cloudwatch_log_group" "sync_lambda" {
  name              = "/aws/lambda/${var.project_name}-sync-recordings"
  retention_in_days = 14

  tags = {
    Name        = "PLAYHUB Sync Lambda Logs"
    Environment = var.environment
  }
}

# Lambda Function
resource "aws_lambda_function" "sync_recordings" {
  function_name = "${var.project_name}-sync-recordings"
  role          = aws_iam_role.sync_lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 900  # 15 minutes (max for Lambda)
  memory_size   = 1024 # 1GB for streaming large video files

  # Note: You need to build and zip the Lambda code first
  # See deployment instructions in README
  filename         = "${path.module}/../lambda/sync-recordings/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/sync-recordings/dist.zip")

  environment {
    variables = {
      SPIIDEO_CLIENT_ID     = var.spiideo_client_id
      SPIIDEO_CLIENT_SECRET = var.spiideo_client_secret
      SPIIDEO_ACCOUNT_ID    = var.spiideo_account_id
      SPIIDEO_USER_ID       = var.spiideo_user_id
      S3_BUCKET             = var.s3_bucket
      S3_REGION             = var.aws_region
      SUPABASE_URL          = var.supabase_url
      SUPABASE_SERVICE_KEY  = var.supabase_service_key
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.sync_lambda,
    aws_iam_role_policy_attachment.sync_lambda_basic
  ]

  tags = {
    Name        = "PLAYHUB Recording Sync"
    Environment = var.environment
  }
}

# EventBridge Rule - trigger every 15 minutes
resource "aws_cloudwatch_event_rule" "sync_schedule" {
  name                = "${var.project_name}-sync-schedule"
  description         = "Trigger recording sync every 15 minutes"
  schedule_expression = "rate(15 minutes)"

  tags = {
    Name        = "PLAYHUB Sync Schedule"
    Environment = var.environment
  }
}

# EventBridge Target - invoke Lambda
resource "aws_cloudwatch_event_target" "sync_lambda" {
  rule      = aws_cloudwatch_event_rule.sync_schedule.name
  target_id = "sync-recordings-lambda"
  arn       = aws_lambda_function.sync_recordings.arn
}

# Permission for EventBridge to invoke Lambda
resource "aws_lambda_permission" "eventbridge_sync" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sync_recordings.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sync_schedule.arn
}

# ============================================================================
# ALERTING (SNS + CloudWatch Alarm)
# ============================================================================

# SNS Topic for alerts
resource "aws_sns_topic" "sync_alerts" {
  name = "${var.project_name}-sync-alerts"

  tags = {
    Name        = "PLAYHUB Sync Alerts"
    Environment = var.environment
  }
}

# Email subscription (only if email provided)
resource "aws_sns_topic_subscription" "sync_alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.sync_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# CloudWatch Alarm - Lambda Errors
resource "aws_cloudwatch_metric_alarm" "sync_lambda_errors" {
  alarm_name          = "${var.project_name}-sync-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 900  # 15 minutes (matches Lambda schedule)
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Sync Lambda function failed"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.sync_recordings.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Sync Error Alarm"
    Environment = var.environment
  }
}

# CloudWatch Alarm - Lambda Timeout (Duration near max)
resource "aws_cloudwatch_metric_alarm" "sync_lambda_timeout" {
  alarm_name          = "${var.project_name}-sync-lambda-timeout"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Maximum"
  threshold           = 840000  # 14 minutes in ms (warning before 15 min timeout)
  alarm_description   = "Sync Lambda approaching timeout limit"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.sync_recordings.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Sync Timeout Alarm"
    Environment = var.environment
  }
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "sync_lambda_arn" {
  value       = aws_lambda_function.sync_recordings.arn
  description = "Sync Lambda function ARN"
}

output "sync_lambda_name" {
  value       = aws_lambda_function.sync_recordings.function_name
  description = "Sync Lambda function name"
}

output "sync_schedule_arn" {
  value       = aws_cloudwatch_event_rule.sync_schedule.arn
  description = "EventBridge schedule rule ARN"
}

output "sync_alerts_topic_arn" {
  value       = aws_sns_topic.sync_alerts.arn
  description = "SNS topic ARN for sync alerts"
}
