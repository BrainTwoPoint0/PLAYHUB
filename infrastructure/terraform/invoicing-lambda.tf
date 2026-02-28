# ============================================================================
# MONTHLY INVOICING LAMBDA + EVENTBRIDGE
# Generates invoices for all active venues on the 1st of every month
# ============================================================================

variable "stripe_secret_key" {
  description = "Stripe secret key for invoice creation"
  type        = string
  sensitive   = true
}

variable "resend_api_key" {
  description = "Resend API key for sending invoice emails"
  type        = string
  sensitive   = true
}

# IAM Role for Invoicing Lambda
resource "aws_iam_role" "invoicing_lambda" {
  name = "${var.project_name}-invoicing-lambda-role"

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
    Name        = "PLAYHUB Invoicing Lambda Role"
    Environment = var.environment
  }
}

# Basic Lambda execution policy (CloudWatch Logs)
resource "aws_iam_role_policy_attachment" "invoicing_lambda_basic" {
  role       = aws_iam_role.invoicing_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "invoicing_lambda" {
  name              = "/aws/lambda/${var.project_name}-monthly-invoicing"
  retention_in_days = 14

  tags = {
    Name        = "PLAYHUB Invoicing Lambda Logs"
    Environment = var.environment
  }
}

# Lambda Function
resource "aws_lambda_function" "monthly_invoicing" {
  function_name = "${var.project_name}-monthly-invoicing"
  role          = aws_iam_role.invoicing_lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 300  # 5 minutes
  memory_size   = 256

  filename         = "${path.module}/../lambda/monthly-invoicing/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/monthly-invoicing/dist.zip")

  environment {
    variables = {
      SUPABASE_URL         = var.supabase_url
      SUPABASE_SERVICE_KEY = var.supabase_service_key
      STRIPE_SECRET_KEY    = var.stripe_secret_key
      RESEND_API_KEY       = var.resend_api_key
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.invoicing_lambda,
    aws_iam_role_policy_attachment.invoicing_lambda_basic
  ]

  tags = {
    Name        = "PLAYHUB Monthly Invoicing"
    Environment = var.environment
  }
}

# EventBridge Rule — 1st of every month at 9am UTC
resource "aws_cloudwatch_event_rule" "invoicing_schedule" {
  name                = "${var.project_name}-invoicing-schedule"
  description         = "Trigger monthly invoice generation on the 1st of every month"
  schedule_expression = "cron(0 9 1 * ? *)"

  tags = {
    Name        = "PLAYHUB Invoicing Schedule"
    Environment = var.environment
  }
}

# EventBridge Target — invoke Lambda
resource "aws_cloudwatch_event_target" "invoicing_lambda" {
  rule      = aws_cloudwatch_event_rule.invoicing_schedule.name
  target_id = "monthly-invoicing-lambda"
  arn       = aws_lambda_function.monthly_invoicing.arn
}

# Permission for EventBridge to invoke Lambda
resource "aws_lambda_permission" "eventbridge_invoicing" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.monthly_invoicing.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.invoicing_schedule.arn
}

# CloudWatch Alarm — Lambda Errors (reuse existing SNS topic)
resource "aws_cloudwatch_metric_alarm" "invoicing_lambda_errors" {
  alarm_name          = "${var.project_name}-invoicing-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 86400  # 24 hours (monthly Lambda, check daily)
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Monthly invoicing Lambda function failed"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.monthly_invoicing.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Invoicing Error Alarm"
    Environment = var.environment
  }
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "invoicing_lambda_arn" {
  value       = aws_lambda_function.monthly_invoicing.arn
  description = "Monthly Invoicing Lambda function ARN"
}

output "invoicing_lambda_name" {
  value       = aws_lambda_function.monthly_invoicing.function_name
  description = "Monthly Invoicing Lambda function name"
}

output "invoicing_schedule_arn" {
  value       = aws_cloudwatch_event_rule.invoicing_schedule.arn
  description = "Invoicing EventBridge schedule rule ARN"
}
