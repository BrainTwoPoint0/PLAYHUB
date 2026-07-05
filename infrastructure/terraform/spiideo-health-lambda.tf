# ============================================================================
# SPIIDEO HEALTH LAMBDA + EVENTBRIDGE
# Polls the INTERNAL Spiideo API (api.spiideo.com) every 15 minutes for scene/
# camera health and upserts a snapshot into playhub_spiideo_scene_health.
#
# The API is reverse-engineered and undocumented, so the alarms below are an
# API-ACCESSIBILITY CANARY: they fire if Spiideo changes sign-in or the /v2
# scene endpoints (ApiReachable / ContractErrors), not on individual cameras
# going offline. Alarms reuse the sync_alerts SNS topic from sync-lambda.tf.
# Reuses var.spiideo_account_id (same PLAYBACK account as the public client).
# See docs/decisions/2026-07-01-spiideo-scene-health.md.
# ============================================================================

variable "spiideo_play_email" {
  description = "play.spiideo.com login email (internal api.spiideo.com sign-in)"
  type        = string
  sensitive   = true # half a credential — keep out of plan output for symmetry
}

variable "spiideo_play_password" {
  description = "play.spiideo.com login password"
  type        = string
  sensitive   = true
}

# IAM Role
resource "aws_iam_role" "spiideo_health_lambda" {
  name = "${var.project_name}-spiideo-health-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole"
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
      }
    ]
  })

  tags = {
    Name        = "PLAYHUB Spiideo Health Lambda Role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "spiideo_health_lambda_basic" {
  role       = aws_iam_role.spiideo_health_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "spiideo_health_lambda" {
  name              = "/aws/lambda/${var.project_name}-spiideo-health"
  retention_in_days = 14

  tags = {
    Name        = "PLAYHUB Spiideo Health Lambda Logs"
    Environment = var.environment
  }
}

resource "aws_lambda_function" "spiideo_health" {
  function_name = "${var.project_name}-spiideo-health"
  role          = aws_iam_role.spiideo_health_lambda.arn
  handler       = "index.handler"
  # nodejs22.x: supabase-js ≥2.48 needs native WebSocket at client construction
  # (same reason as clutch-sync).
  runtime       = "nodejs22.x"
  timeout       = 120 # light HTTP + a single upsert; no video streaming
  memory_size   = 256

  filename         = "${path.module}/../lambda/spiideo-health/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/spiideo-health/dist.zip")

  environment {
    variables = {
      SPIIDEO_PLAY_EMAIL    = var.spiideo_play_email
      SPIIDEO_PLAY_PASSWORD = var.spiideo_play_password
      SPIIDEO_ACCOUNT_ID    = var.spiideo_account_id
      SUPABASE_URL          = var.supabase_url
      SUPABASE_SERVICE_KEY  = var.supabase_service_key
      RESEND_API_KEY        = var.resend_api_key
      ALERT_EMAIL           = var.alert_email
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.spiideo_health_lambda,
    aws_iam_role_policy_attachment.spiideo_health_lambda_basic
  ]

  tags = {
    Name        = "PLAYHUB Spiideo Health"
    Environment = var.environment
  }
}

# EventBridge Rule — every 15 minutes
resource "aws_cloudwatch_event_rule" "spiideo_health_schedule" {
  name                = "${var.project_name}-spiideo-health-schedule"
  description         = "Trigger Spiideo scene-health poll every 15 minutes"
  schedule_expression = "rate(15 minutes)"

  tags = {
    Name        = "PLAYHUB Spiideo Health Schedule"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "spiideo_health_lambda" {
  rule      = aws_cloudwatch_event_rule.spiideo_health_schedule.name
  target_id = "spiideo-health-lambda"
  arn       = aws_lambda_function.spiideo_health.arn
}

resource "aws_lambda_permission" "eventbridge_spiideo_health" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.spiideo_health.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.spiideo_health_schedule.arn
}

# ============================================================================
# API-ACCESSIBILITY CANARY ALARMS (reuse aws_sns_topic.sync_alerts)
# ============================================================================

# The handler THROWS on any sign-in / fetch / contract failure, so a broken
# reverse-engineered API surfaces here as a Lambda invocation error.
resource "aws_cloudwatch_metric_alarm" "spiideo_health_lambda_errors" {
  alarm_name          = "${var.project_name}-spiideo-health-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Spiideo health Lambda errored — internal API sign-in/fetch failed or response shape changed"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.spiideo_health.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Spiideo Health Error Alarm"
    Environment = var.environment
  }
}

# Zero-invocations — catches the EventBridge rule being disabled/deleted. Lambda
# emits NO Invocations datapoint when idle, so missing data must breach or the
# alarm parks in INSUFFICIENT_DATA. Expect one page right after first deploy
# until the first tick.
resource "aws_cloudwatch_metric_alarm" "spiideo_health_lambda_no_invocations" {
  alarm_name          = "${var.project_name}-spiideo-health-lambda-no-invocations"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Spiideo health Lambda not invoked for 30 minutes — EventBridge rule may be disabled or deleted"
  treat_missing_data  = "breaching"

  dimensions = {
    FunctionName = aws_lambda_function.spiideo_health.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Spiideo Health No-Invocations Alarm"
    Environment = var.environment
  }
}

# API-reachable canary — the handler emits ApiReachable=1 only after a valid
# sign-in + contract. A run that emits 0 (or the metric goes missing while the
# Lambda still runs) means the internal API is inaccessible. Missing data is
# handled by the no-invocations alarm above, so treat it as notBreaching here.
resource "aws_cloudwatch_metric_alarm" "spiideo_health_api_unreachable" {
  alarm_name          = "${var.project_name}-spiideo-health-api-unreachable"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApiReachable"
  namespace           = "PLAYHUB/SpiideoHealth"
  period              = 900
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "Spiideo internal API unreachable for 30+ minutes — sign-in failing or endpoints moved"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Spiideo Health API Unreachable Alarm"
    Environment = var.environment
  }
}

# Contract-drift canary — emitted as 1 when the response parsed but lost fields
# we depend on (sign-in jwt, overview counts, scene.status shape). Distinct from
# ApiReachable so the alert says "shape changed" vs "API gone".
resource "aws_cloudwatch_metric_alarm" "spiideo_health_contract_errors" {
  alarm_name          = "${var.project_name}-spiideo-health-contract-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ContractErrors"
  namespace           = "PLAYHUB/SpiideoHealth"
  period              = 900
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Spiideo API response shape changed for 30+ minutes — re-run recon to find the new schema"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Spiideo Health Contract Errors Alarm"
    Environment = var.environment
  }
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "spiideo_health_lambda_name" {
  value       = aws_lambda_function.spiideo_health.function_name
  description = "Spiideo health Lambda function name"
}
