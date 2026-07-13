# ─────────────────────────────────────────────────────────────────────────────
# AWS BATCH — AIM TRACK  (extends vp-materialize-batch.tf)
#
# Registers a recording's produced Play render (s3_key) against its preserved
# raw VirtualPanorama (panorama_s3_key) via SIFT (CPU-only, multi-hour) and
# publishes the {t, pan, tilt, fov} auto-follow track to the public
# panorama-meshes bucket. No Spiideo dependency — both inputs live in our S3.
#
# Reuses vp-materialize's Fargate CE + QUEUE (both jobs are sporadic and the CE
# has 16 vCPU headroom over the shared in-flight caps) plus the shared batch_job /
# batch_execution roles. Adds only: an ECR repo, a CodeBuild image project, a job
# definition, and a log group.
#
# Triggered by the sync-recordings Lambda's aim-track sweep (attempts-counting
# budget), passing RECORDING_ID + GAME_ID as container env overrides.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "aim_track" {
  name                 = "${var.project_name}-aim-track"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "PLAYHUB Aim Track", Environment = var.environment }
}

resource "aws_ecr_lifecycle_policy" "aim_track" {
  repository = aws_ecr_repository.aim_track.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "aim_track" {
  name              = "/aws/batch/${var.project_name}-aim-track"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB Aim Track Logs", Environment = var.environment }
}

resource "aws_batch_job_definition" "aim_track" {
  name                  = "${var.project_name}-aim-track"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.aim_track.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn       # S3 read/write on the bucket
    executionRoleArn = aws_iam_role.batch_execution.arn # ECR pull + logs (Fargate)

    resourceRequirements = [
      { type = "VCPU", value = "2" }, # SIFT is CPU-bound single-threaded; 2 is plenty
      { type = "MEMORY", value = "4096" }
    ]
    # Inputs: full-match Play mp4 (~2-6 GB) + raw VP mp4 (multi-GB 4K). No
    # transcoding, so ~2× input size covers it.
    ephemeralStorage = { sizeInGiB = 60 }

    networkConfiguration = { assignPublicIp = "ENABLED" }
    runtimePlatform      = { cpuArchitecture = "X86_64", operatingSystemFamily = "LINUX" }

    # RECORDING_ID + GAME_ID are injected per-job by SubmitJob containerOverrides.
    # SUPABASE_SERVICE_ROLE_KEY as plaintext env matches vp-materialize's
    # accepted surface. The Secrets Manager swap (secret defined in
    # batch-precompute.tf) is BLOCKED on IAM: playhub-admin lacks
    # secretsmanager:CreateSecret (org guardrail, verified 2026-07-13) — swap
    # both job defs to `secrets = [{ valueFrom = ... }]` once that's granted.
    environment = [
      { name = "S3_RECORDINGS_BUCKET", value = var.s3_bucket },
      { name = "VP_S3_PREFIX", value = "panoramas" },
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "SUPABASE_SERVICE_ROLE_KEY", value = var.supabase_service_key },
      { name = "SAMPLE_FPS", value = "5" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.aim_track.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "aim-track"
      }
    }
  })

  timeout {
    # Full-match SIFT at 5 fps is ~4-7.5h single-threaded — cap at 10h so a
    # wedged decode can't burn a day of Fargate.
    attempt_duration_seconds = 36000
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

  tags = { Name = "PLAYHUB Aim Track Job", Environment = var.environment }
}

# CodeBuild project to build + push the image (no local Docker needed).
# Same source-zip flow as vp-materialize (whose project predates terraform and
# lives outside it): zip infrastructure/batch/aim-track/ →
# s3://{bucket}/codebuild/aim-track-src.zip → start-build.
resource "aws_iam_role" "codebuild_aim_track" {
  name = "${var.project_name}-codebuild-aim-track"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "PLAYHUB Aim Track CodeBuild", Environment = var.environment }
}

resource "aws_iam_role_policy" "codebuild_aim_track" {
  name = "${var.project_name}-codebuild-aim-track"
  role = aws_iam_role.codebuild_aim_track.id
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
        Resource = aws_ecr_repository.aim_track.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:aws:s3:::${var.s3_bucket}/codebuild/aim-track-src.zip"
      },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/codebuild/${var.project_name}-aim-track-image*"
      },
    ]
  })
}

resource "aws_codebuild_project" "aim_track_image" {
  name          = "${var.project_name}-aim-track-image"
  service_role  = aws_iam_role.codebuild_aim_track.arn
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
      value = aws_ecr_repository.aim_track.repository_url
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.aws_region
    }
  }

  source {
    type     = "S3"
    location = "${var.s3_bucket}/codebuild/aim-track-src.zip"
  }

  tags = { Name = "PLAYHUB Aim Track Image Build", Environment = var.environment }
}

output "aim_track_ecr_url" {
  value = aws_ecr_repository.aim_track.repository_url
}
output "aim_track_job_definition" {
  value = aws_batch_job_definition.aim_track.name
}
output "aim_track_codebuild_project" {
  value = aws_codebuild_project.aim_track_image.name
}
