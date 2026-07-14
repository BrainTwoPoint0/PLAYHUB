# ─────────────────────────────────────────────────────────────────────────────
# AWS BATCH — PLAYER TRACKLETS  (extends vp-materialize-batch.tf)
#
# Fetches Spiideo's tracklets + object-detections data streams for a game
# (public CloudFront items; JWT only for stream discovery), solves the
# per-game metric→ray homography from detection-feet ↔ tracklet
# correspondences, and publishes the per-player {t, pan, tilt} spotlight
# track to the public panorama-meshes bucket. CPU-only, minutes per game,
# no video download — the lightest job on the shared queue.
#
# Reuses vp-materialize's Fargate CE + QUEUE and the shared batch_job /
# batch_execution roles. vCPU budget on the shared CE: vp 5×2 + aim 2×2 +
# portrait 1×1 + tracklets 1×1 = 16.
#
# Triggered by the sync-recordings Lambda's tracklets sweep, passing
# RECORDING_ID + GAME_ID as container env overrides.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "player_tracklets" {
  name                 = "${var.project_name}-player-tracklets"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "PLAYHUB Player Tracklets", Environment = var.environment }
}

resource "aws_ecr_lifecycle_policy" "player_tracklets" {
  repository = aws_ecr_repository.player_tracklets.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "player_tracklets" {
  name              = "/aws/batch/${var.project_name}-player-tracklets"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB Player Tracklets Logs", Environment = var.environment }
}

resource "aws_batch_job_definition" "player_tracklets" {
  name                  = "${var.project_name}-player-tracklets"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.player_tracklets.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn       # S3 read/write on the bucket
    executionRoleArn = aws_iam_role.batch_execution.arn # ECR pull + logs (Fargate)

    resourceRequirements = [
      { type = "VCPU", value = "1" }, # JSON fetch + a homography solve — light
      { type = "MEMORY", value = "2048" }
    ]
    # Data streams are tens of MB of JSON; the Fargate default 20 GiB is ample.

    networkConfiguration = { assignPublicIp = "ENABLED" }
    runtimePlatform      = { cpuArchitecture = "X86_64", operatingSystemFamily = "LINUX" }

    # RECORDING_ID + GAME_ID are injected per-job by SubmitJob containerOverrides.
    # Plaintext secrets match the accepted vp-materialize/aim-track surface —
    # the Secrets Manager swap is BLOCKED on org IAM (no CreateSecret); swap all
    # job defs together once granted. SPIIDEO creds are the same account login
    # every other Spiideo integration uses.
    environment = [
      { name = "S3_RECORDINGS_BUCKET", value = var.s3_bucket },
      { name = "VP_S3_PREFIX", value = "panoramas" },
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "SUPABASE_SERVICE_ROLE_KEY", value = var.supabase_service_key },
      { name = "SPIIDEO_PLAY_EMAIL", value = var.spiideo_play_email },
      { name = "SPIIDEO_PLAY_PASSWORD", value = var.spiideo_play_password },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.player_tracklets.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "player-tracklets"
      }
    }
  })

  timeout {
    # Fetch + solve runs in minutes; 1h cap means a wedged network loop can't
    # hold the queue slot hostage.
    attempt_duration_seconds = 3600
  }
  retry_strategy {
    attempts = 2
    evaluate_on_exit {
      on_exit_code = "1"
      action       = "EXIT" # real app failure — the sweep's attempts cap owns retries
    }
    evaluate_on_exit {
      on_reason = "*"
      action    = "RETRY" # infra/placement fault — retry
    }
  }

  tags = { Name = "PLAYHUB Player Tracklets Job", Environment = var.environment }
}

# CodeBuild project to build + push the image (no local Docker needed).
# Source-zip flow: zip infrastructure/batch/player-tracklets/ →
# s3://{bucket}/codebuild/player-tracklets-src.zip → start-build.
resource "aws_iam_role" "codebuild_player_tracklets" {
  name = "${var.project_name}-codebuild-player-tracklets"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "PLAYHUB Player Tracklets CodeBuild", Environment = var.environment }
}

resource "aws_iam_role_policy" "codebuild_player_tracklets" {
  name = "${var.project_name}-codebuild-player-tracklets"
  role = aws_iam_role.codebuild_player_tracklets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.player_tracklets.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:aws:s3:::${var.s3_bucket}/codebuild/player-tracklets-src.zip"
      },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/codebuild/${var.project_name}-player-tracklets-image*"
      },
    ]
  })
}

resource "aws_codebuild_project" "player_tracklets_image" {
  name          = "${var.project_name}-player-tracklets-image"
  service_role  = aws_iam_role.codebuild_player_tracklets.arn
  build_timeout = 30

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "ECR_REPO_URL"
      value = aws_ecr_repository.player_tracklets.repository_url
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.aws_region
    }
  }

  source {
    type     = "S3"
    location = "${var.s3_bucket}/codebuild/player-tracklets-src.zip"
  }

  tags = { Name = "PLAYHUB Player Tracklets Image Build", Environment = var.environment }
}

output "player_tracklets_ecr_url" {
  value = aws_ecr_repository.player_tracklets.repository_url
}
output "player_tracklets_job_definition" {
  value = aws_batch_job_definition.player_tracklets.name
}
output "player_tracklets_codebuild_project" {
  value = aws_codebuild_project.player_tracklets_image.name
}
