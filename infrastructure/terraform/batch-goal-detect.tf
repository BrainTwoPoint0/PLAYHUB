# ─────────────────────────────────────────────────────────────────────────────
# AWS BATCH — GOAL DETECT  (review-first Spiideo goal producer)
#
# Runs the FROZEN goal-detection chain (Veo-freeze-validated 2026-07-21:
# medium recall90 0.81 / precision 0.31 / ~18 candidates per match) on the
# public tracklets artifact of allowlisted Spiideo recordings, cuts a review
# clip per candidate from the produced mp4 (ffmpeg range-seek — the video is
# never fully downloaded), and writes review-first rows into
# playhub_goal_candidates. Platform-admin review approves candidates into
# playhub_recording_events; nothing auto-publishes.
#
# CPU-only sklearn + ffmpeg — no torch, no GPU. OWN compute environment +
# queue, deliberately NOT the shared vp-materialize CE (resizing it means
# applying a pre-existing resource in a state file with known unapplied
# drift — all-new resources keep -target applies surgical; jersey-labels
# precedent).
#
# No Spiideo/Veo credentials: inputs are exclusively our own artifacts.
# ─────────────────────────────────────────────────────────────────────────────

variable "goal_detect_scenes" {
  description = "Comma-separated Spiideo scene-id allowlist for the goal-detect sweep (empty = disabled)"
  type        = string
  default     = ""
}

resource "aws_ecr_repository" "goal_detect" {
  name                 = "${var.project_name}-goal-detect"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "PLAYHUB Goal Detect", Environment = var.environment }
}

resource "aws_ecr_lifecycle_policy" "goal_detect" {
  repository = aws_ecr_repository.goal_detect.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "goal_detect" {
  name              = "/aws/batch/${var.project_name}-goal-detect"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB Goal Detect Logs", Environment = var.environment }
}

resource "aws_batch_compute_environment" "goal_detect" {
  compute_environment_name = "${var.project_name}-goal-detect"
  type                     = "MANAGED"
  state                    = "ENABLED"
  service_role             = aws_iam_role.batch_service.arn

  compute_resources {
    type = "FARGATE"
    # Exactly one job's worth: the sweep's GOAL_DETECT_INFLIGHT_CAP=1 ×
    # 2 vCPU. Raise both together or the second job silently queues.
    max_vcpus          = 2
    subnets            = data.aws_subnets.default.ids
    security_group_ids = [aws_security_group.batch.id]
  }

  tags = { Name = "PLAYHUB Goal Detect CE", Environment = var.environment }
}

resource "aws_batch_job_queue" "goal_detect" {
  name     = "${var.project_name}-goal-detect-queue"
  state    = "ENABLED"
  priority = 1
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.goal_detect.arn
  }
  tags = { Name = "PLAYHUB Goal Detect Queue", Environment = var.environment }
}

resource "aws_batch_job_definition" "goal_detect" {
  name                  = "${var.project_name}-goal-detect"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.goal_detect.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn       # S3 read/write on the bucket
    executionRoleArn = aws_iam_role.batch_execution.arn # ECR pull + logs (Fargate)

    resourceRequirements = [
      # 2 vCPU / 4 GiB: the chain is numpy + three shallow-tree predicts
      # (~seconds); wall-clock is ~18 ffmpeg clip encodes at ~100s each.
      { type = "VCPU", value = "2" },
      { type = "MEMORY", value = "4096" }
    ]
    # Default 20 GiB ephemeral is plenty: the produced mp4 is range-seeked
    # via presigned URL (never fully downloaded); clips are ~10-40 MB each
    # and deleted after upload.

    networkConfiguration = { assignPublicIp = "ENABLED" }
    runtimePlatform      = { cpuArchitecture = "X86_64", operatingSystemFamily = "LINUX" }

    # RECORDING_ID + GAME_ID are injected per-job by SubmitJob
    # containerOverrides. Same plaintext-secret surface as the sibling job
    # defs (Secrets Manager swap blocked on org IAM).
    environment = [
      { name = "S3_RECORDINGS_BUCKET", value = var.s3_bucket },
      # Explicit region: the presign guard (SigV2/global-endpoint pilot
      # lesson) must be structural, not a lucky fallback default.
      { name = "AWS_REGION", value = var.aws_region },
      { name = "GOAL_WEIGHTS_S3_PREFIX", value = "provenance/goal-detect/2026-07-21" },
      # sha256 pins for the frozen sklearn artifacts + constants the job
      # downloads — computed from the banked originals (integrity; the
      # unpickle surface is our own service-role-written S3 prefix).
      { name = "STOPPAGE_SHA256", value = "c97f6bc97fd742da23a4ef8ce579abdbdc1ab2a3638a35527c4b05c38e810aea" },
      { name = "KICKOFF_SHA256", value = "f799a53e73e24bfbdbd092bae7e1dc15983656078617c427b38a521b2dfde4d3" },
      { name = "PERIOD_GAP_SHA256", value = "f8fd7a84cffe29a938ed8c85a9ea9c2c8bc844161e0a22949e91749ff969be8f" },
      { name = "CONSTANTS_SHA256", value = "11b49062a9edd0c759076b4781667819d0688623ff6e959c3a6daed8b8ee1347" },
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "SUPABASE_SERVICE_ROLE_KEY", value = var.supabase_service_key },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.goal_detect.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "goal-detect"
      }
    }
  })

  timeout {
    # Measured budget: chain ~2 min + ~18 clips × ~100 s encode ≈ 35 min.
    # 2 h covers a long match + slow presigned reads without letting a
    # wedged job hold the CE.
    attempt_duration_seconds = 7200
  }
  retry_strategy {
    # attempts=1: the sweep owns ALL retries (veo-capture lesson — a Batch
    # timeout exits 137 and would fall through any on_exit_code rule into a
    # Batch-level retry racing the sweep's attempt accounting).
    attempts = 1
  }

  tags = { Name = "PLAYHUB Goal Detect Job", Environment = var.environment }
}

# CodeBuild project to build + push the image (no local Docker needed).
# Source-zip flow: zip infrastructure/batch/goal-detect/ (all modules are
# vendored — no staged shared files) →
# s3://{bucket}/codebuild/goal-detect-src.zip → start-build.
resource "aws_iam_role" "codebuild_goal_detect" {
  name = "${var.project_name}-codebuild-goal-detect"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "PLAYHUB Goal Detect CodeBuild", Environment = var.environment }
}

resource "aws_iam_role_policy" "codebuild_goal_detect" {
  name = "${var.project_name}-codebuild-goal-detect"
  role = aws_iam_role.codebuild_goal_detect.id
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
        Resource = aws_ecr_repository.goal_detect.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:aws:s3:::${var.s3_bucket}/codebuild/goal-detect-src.zip"
      },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/codebuild/${var.project_name}-goal-detect-image*"
      },
    ]
  })
}

resource "aws_codebuild_project" "goal_detect_image" {
  name          = "${var.project_name}-goal-detect-image"
  service_role  = aws_iam_role.codebuild_goal_detect.arn
  build_timeout = 20 # slim image: python-slim + ffmpeg + sklearn wheels

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
      value = aws_ecr_repository.goal_detect.repository_url
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.aws_region
    }
  }

  source {
    type     = "S3"
    location = "${var.s3_bucket}/codebuild/goal-detect-src.zip"
  }

  tags = { Name = "PLAYHUB Goal Detect Image Build", Environment = var.environment }
}

output "goal_detect_ecr_url" {
  value = aws_ecr_repository.goal_detect.repository_url
}
output "goal_detect_job_definition" {
  value = aws_batch_job_definition.goal_detect.name
}
output "goal_detect_codebuild_project" {
  value = aws_codebuild_project.goal_detect_image.name
}
output "goal_detect_queue" {
  value = aws_batch_job_queue.goal_detect.name
}
