# ============================================================================
# SPIIDEO SNAPSHOT LAMBDA + FUNCTION URL + FFMPEG LAYER
# On-demand raw-panorama still of a scene's camera. Invoked ASYNC from the
# PLAYHUB admin API (Function URL + X-Amz-Invocation-Type: Event), because the
# capture takes ~40-60s (live session spin-up) — well past Netlify's ~26s.
# It grabs one frame with ffmpeg (from the layer), uploads to the public
# scene-snapshots bucket, and stamps playhub_spiideo_scene_health.
# See docs/decisions/2026-07-01-spiideo-scene-health.md.
# ============================================================================

variable "snapshot_api_key" {
  description = "Shared secret the PLAYHUB API sends to the snapshot Function URL"
  type        = string
  sensitive   = true
}

# ffmpeg static binary → /opt/bin/ffmpeg in the Lambda. Build with
# infrastructure/lambda/layers/ffmpeg/build.sh before apply. x86_64 only.
resource "aws_lambda_layer_version" "ffmpeg" {
  layer_name               = "${var.project_name}-ffmpeg"
  filename                 = "${path.module}/../lambda/layers/ffmpeg/layer.zip"
  source_code_hash         = filebase64sha256("${path.module}/../lambda/layers/ffmpeg/layer.zip")
  compatible_runtimes      = ["nodejs22.x", "nodejs20.x"]
  compatible_architectures = ["x86_64"]
}

resource "aws_iam_role" "spiideo_snapshot_lambda" {
  name = "${var.project_name}-spiideo-snapshot-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
  tags = { Name = "PLAYHUB Spiideo Snapshot Lambda Role", Environment = var.environment }
}

resource "aws_iam_role_policy_attachment" "spiideo_snapshot_lambda_basic" {
  role       = aws_iam_role.spiideo_snapshot_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "spiideo_snapshot_lambda" {
  name              = "/aws/lambda/${var.project_name}-spiideo-snapshot"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB Spiideo Snapshot Lambda Logs", Environment = var.environment }
}

resource "aws_lambda_function" "spiideo_snapshot" {
  function_name = "${var.project_name}-spiideo-snapshot"
  role          = aws_iam_role.spiideo_snapshot_lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["x86_64"] # ffmpeg layer binary is amd64
  timeout       = 150        # live spin-up (~40-60s poll) + ffmpeg + upload
  memory_size   = 1024       # ffmpeg decode is CPU-bound; ~0.58 vCPU + large panorama frame buffer

  filename         = "${path.module}/../lambda/spiideo-snapshot/dist.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda/spiideo-snapshot/dist.zip")

  layers = [aws_lambda_layer_version.ffmpeg.arn]

  environment {
    variables = {
      SPIIDEO_PLAY_EMAIL    = var.spiideo_play_email
      SPIIDEO_PLAY_PASSWORD = var.spiideo_play_password
      SPIIDEO_ACCOUNT_ID    = var.spiideo_account_id
      SUPABASE_URL          = var.supabase_url
      SUPABASE_SERVICE_KEY  = var.supabase_service_key
      SNAPSHOT_API_KEY      = var.snapshot_api_key
      FFMPEG_PATH           = "/opt/bin/ffmpeg"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.spiideo_snapshot_lambda,
    aws_iam_role_policy_attachment.spiideo_snapshot_lambda_basic,
  ]

  tags = { Name = "PLAYHUB Spiideo Snapshot", Environment = var.environment }
}

# Async invoke retries default to 2 — which could double-trigger a live camera
# session on a transient failure. Match the fleet (lyl-sync, veo-sync): none.
resource "aws_lambda_function_event_invoke_config" "spiideo_snapshot" {
  function_name          = aws_lambda_function.spiideo_snapshot.function_name
  maximum_retry_attempts = 0
}

# No Function URL: this account's org guardrail blocks Function URL invocations
# (even IAM-authed ones 403), so the PLAYHUB route invokes the function DIRECTLY
# (lambda:Invoke, InvocationType=Event) as the scoped invoker user below. Static
# keys live in the PLAYHUB (Netlify) env; the in-handler x-api-key is
# defense-in-depth.
resource "aws_iam_user" "snapshot_invoker" {
  name = "${var.project_name}-snapshot-invoker"
  tags = { Name = "PLAYHUB Snapshot Invoker", Environment = var.environment }
}

resource "aws_iam_user_policy" "snapshot_invoker" {
  name = "invoke-snapshot"
  user = aws_iam_user.snapshot_invoker.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.spiideo_snapshot.arn
    }]
  })
}

resource "aws_iam_access_key" "snapshot_invoker" {
  user = aws_iam_user.snapshot_invoker.name
}

# Error alarm on the shared sync_alerts topic (no schedule — on-demand).
resource "aws_cloudwatch_metric_alarm" "spiideo_snapshot_lambda_errors" {
  alarm_name          = "${var.project_name}-spiideo-snapshot-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 900
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Spiideo snapshot Lambda threw (unhandled) — capture failures are recorded on the health row, so this catches infra faults"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.spiideo_snapshot.function_name }
  alarm_actions       = [aws_sns_topic.sync_alerts.arn]
  ok_actions          = [aws_sns_topic.sync_alerts.arn]
  tags                = { Name = "PLAYHUB Spiideo Snapshot Error Alarm", Environment = var.environment }
}

output "snapshot_invoker_access_key_id" {
  value       = aws_iam_access_key.snapshot_invoker.id
  description = "Set as SNAPSHOT_INVOKE_AWS_ACCESS_KEY_ID in PLAYHUB Netlify env"
  sensitive   = true
}

output "snapshot_invoker_secret_access_key" {
  value       = aws_iam_access_key.snapshot_invoker.secret
  description = "Set as SNAPSHOT_INVOKE_AWS_SECRET_ACCESS_KEY in PLAYHUB Netlify env"
  sensitive   = true
}
