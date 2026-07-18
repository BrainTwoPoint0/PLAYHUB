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

# S3 permissions for uploading recordings (DeleteObject: the zombie sweep
# removes objects for deletions the app started but never completed)
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
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "arn:aws:s3:::${var.s3_bucket}/*"
      }
    ]
  })
}

# Every Batch job class the sync Lambda's sweeps submit — panorama capture
# (preserve-first, 2026-07-07: vp-materialize jobs for published recordings
# still missing their raw panorama, since Spiideo purges the raw source ~30
# days after a game), aim-track, portrait-render, player-tracklets, and
# veo-capture (the same preserve-first race against Veo's ~150d Glacier archive
# of the native panorama we need as a jersey-training corpus).
#
# The IAM grant below is derived from this map, so a new job class cannot ship
# with a working sweep and a missing permission.
#
# It could before, and did: player-tracklets shipped 2026-07-15 without its
# grant, so sweepPlayerTracklets had NEVER submitted a single job. Every tick
# logged "0 submitted, N claimable", wrote 'sweep submit failed' to the row,
# and rolled the attempt counter back — so rows never settled, never ran, and
# never alarmed (the sweeps are deliberately non-fatal, so Lambda Errors stays
# 0). The pilot looked healthy only because a human submitted it by hand.
# A comment saying "remember to add your job class here" is a request that a
# human remember; this map makes forgetting impossible.
locals {
  sweep_job_defs = {
    panorama    = aws_batch_job_definition.vp_materialize
    aim_track   = aws_batch_job_definition.aim_track
    portrait    = aws_batch_job_definition.portrait_render
    tracklets   = aws_batch_job_definition.player_tracklets
    veo_capture = aws_batch_job_definition.veo_capture
    jersey      = aws_batch_job_definition.jersey_labels
  }
  # Queues the sweeps submit to. The job-def map above cannot cover queues,
  # and SubmitJob authorizes against BOTH — a job class on a NEW queue whose
  # ARN is missing here goes silently inert in exactly the player-tracklets
  # 2026-07-15 pattern (0 submitted, N claimable, no alarm).
  sweep_job_queues = [
    aws_batch_job_queue.vp_materialize.arn,
    aws_batch_job_queue.jersey_labels.arn,
  ]
}

resource "aws_iam_role_policy" "sync_lambda_batch" {
  name = "${var.project_name}-sync-lambda-batch"
  role = aws_iam_role.sync_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["batch:SubmitJob"]
        # SubmitJob authorizes against BOTH the queue and the job definition,
        # so a missing queue ARN denies identically to a missing job-def ARN.
        # Queues come from locals.sweep_job_queues (jersey-labels runs on its
        # own dedicated CE/queue; everything else shares vp-materialize).
        Resource = concat(
          local.sweep_job_queues,
          # The Lambda submits by NAME, so IAM authorizes against the
          # UNVERSIONED ARN — that is `arn_prefix`, and it is the entry that
          # actually grants access. (Confirmed by the live denial, which named
          # `job-definition/playhub-player-tracklets` with no :revision.) The
          # `:*` is belt-and-braces for a future caller that submits an
          # explicit revision or a full ARN; terraform bumps the revision on
          # every job-def change.
          flatten([for d in local.sweep_job_defs : [
            d.arn_prefix, "${d.arn_prefix}:*",
          ]]),
        )
      },
      {
        # The portrait sweep's duplicate guard. ListJobs does not support
        # resource-level permissions — "*" is the only valid resource.
        Effect   = "Allow"
        Action   = ["batch:ListJobs"]
        Resource = "*"
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

  # TODO: Uncomment once AWS account Lambda concurrency quota is raised
  # above 10. Service Quotas request drafted in the 2026-04-20 session
  # log; once approved, flip this line on and `terraform apply`.
  # reserved_concurrent_executions = 1
  #
  # The sync handler reconciles shared state (Spiideo games, S3 objects,
  # playhub_match_recordings rows); overlapping runs theoretically race
  # on the oldest game. At account quota = 10, reserving 1 would drop
  # unreserved below AWS's 10-minimum floor and the apply fails. Until
  # approved, overlap is mitigated by cron spacing + sync duration
  # historically staying well under 15 min.

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
      RESEND_API_KEY        = var.resend_api_key
      ALERT_EMAIL           = var.alert_email
      PANORAMA_JOB_QUEUE    = aws_batch_job_queue.vp_materialize.name
      PANORAMA_JOB_DEF      = aws_batch_job_definition.vp_materialize.name
      AIM_TRACK_JOB_DEF     = aws_batch_job_definition.aim_track.name
      TRACKLETS_JOB_DEF     = aws_batch_job_definition.player_tracklets.name
      FIELD_FILTER_SCENES   = var.field_filter_scenes
      PORTRAIT_JOB_DEF      = aws_batch_job_definition.portrait_render.name
      VEO_CAPTURE_JOB_DEF   = aws_batch_job_definition.veo_capture.name
      JERSEY_JOB_DEF        = aws_batch_job_definition.jersey_labels.name
      JERSEY_JOB_QUEUE      = aws_batch_job_queue.jersey_labels.name
      # Club allowlist for the portrait sweep; empty = disabled. Flip to "cfa"
      # after the pilot E2E validates.
      PORTRAIT_CLUBS = var.portrait_clubs
      # Organized-kit venue allowlist (Spiideo scene ids) for the jersey
      # sweep; empty = disabled. Enable HCT only after the pilot E2E.
      JERSEY_VENUES = var.jersey_venues
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
  period              = 900 # 15 minutes (matches Lambda schedule)
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
  threshold           = 840000 # 14 minutes in ms (warning before 15 min timeout)
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

# ----------------------------------------------------------------------------
# Zero-invocations alarm — catches EventBridge rule being deleted,
# disabled, or silently drifting. If nothing invokes the Lambda for
# 30 min (two 15-min cron windows), something's wrong with the schedule.
#
# Lambda publishes NO Invocations datapoint for idle periods — the metric
# goes MISSING, it does not go to zero. With `treat_missing_data =
# "missing"` the alarm parked in INSUFFICIENT_DATA and could never notify
# (latent defect since 2026-04-20). "breaching" makes a silent schedule
# actually page; the one-time cost is a phantom page right after a fresh
# deploy until the first cron tick, which clears via ok_actions.
# ----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "sync_lambda_no_invocations" {
  alarm_name          = "${var.project_name}-sync-lambda-no-invocations"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 900 # 15 minutes (matches cron cadence)
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Sync Lambda has not been invoked for 30 minutes — EventBridge rule may be disabled or deleted"
  treat_missing_data  = "breaching"

  dimensions = {
    FunctionName = aws_lambda_function.sync_recordings.function_name
  }

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Sync No-Invocations Alarm"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# Backlog-size alarm — custom metric emitted by the Lambda via EMF.
# A persistent backlog of >10 finished-but-unsynced games for 2
# consecutive runs signals Spiideo slowdown, a download-readiness
# bottleneck, or a bug in the exclusion logic. Ten is loose enough to
# ignore a transient burst but tight enough to catch a real pileup.
# ----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "sync_backlog_size" {
  alarm_name          = "${var.project_name}-sync-backlog-size"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "BacklogSize"
  namespace           = "PLAYHUB/SyncRecordings"
  period              = 900
  statistic           = "Maximum"
  threshold           = 10
  alarm_description   = "Sync backlog > 10 games for 30 min — Spiideo may be slow or download-readiness is stalling"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Sync Backlog Alarm"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# Sync-lag alarm — custom metric emitted by the Lambda via EMF.
# Measures the age of the oldest unsynced finished game at the top of
# each run. 3 hours is well past any legitimate end-of-match processing
# window, so crossing it means a game is genuinely stuck.
# ----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "sync_lag" {
  alarm_name          = "${var.project_name}-sync-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SyncLagSeconds"
  namespace           = "PLAYHUB/SyncRecordings"
  period              = 900
  statistic           = "Maximum"
  threshold           = 10800 # 3 hours
  alarm_description   = "A finished Spiideo game has been unsynced for >3 hours — investigate manually"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.sync_alerts.arn]
  ok_actions    = [aws_sns_topic.sync_alerts.arn]

  tags = {
    Name        = "PLAYHUB Sync Lag Alarm"
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
