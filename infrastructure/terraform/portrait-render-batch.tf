# ─────────────────────────────────────────────────────────────────────────────
# AWS BATCH — PORTRAIT RENDER  (extends vp-materialize-batch.tf / aim-track)
#
# Renders every tagged Veo goal of one match into a 9:16 draft (review-first —
# nothing auto-publishes). Pure orchestration container: clip URLs come from
# the DB content cache, detection + ffmpeg run on Modal, output goes to the
# portrait-crops Supabase bucket. No Veo API, no GPU, tiny footprint.
#
# Shares the vp_materialize Fargate CE + queue. Capacity math on the 16-vCPU
# CE: vp 5×2 + aim 2×2 + portrait 1×1 = 15 ≤ 16 — caps still guarantee no
# queueing for the interactive vp jobs.
#
# Triggered by the sync-recordings Lambda's portrait sweep (1 match/run,
# PORTRAIT_CLUBS allowlist — CFA pilot), passing MATCH_SLUG + CLUB_SLUG as
# container env overrides.
# ─────────────────────────────────────────────────────────────────────────────

variable "portrait_clubs" {
  description = "Comma-separated club allowlist for the portrait-render sweep (empty = disabled)"
  type        = string
  default     = ""
}

variable "modal_crop_url" {
  description = "Modal portrait_crop_process endpoint (ball detection)"
  type        = string
  sensitive   = true
}
variable "modal_render_url" {
  description = "Modal render_portrait endpoint (ffmpeg crop render)"
  type        = string
  sensitive   = true
}
variable "modal_shared_secret" {
  description = "X-Modal-Auth shared secret for both Modal endpoints"
  type        = string
  sensitive   = true
}

resource "aws_ecr_repository" "portrait_render" {
  name                 = "${var.project_name}-portrait-render"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "PLAYHUB Portrait Render", Environment = var.environment }
}

resource "aws_ecr_lifecycle_policy" "portrait_render" {
  repository = aws_ecr_repository.portrait_render.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "portrait_render" {
  name              = "/aws/batch/${var.project_name}-portrait-render"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB Portrait Render Logs", Environment = var.environment }
}

resource "aws_batch_job_definition" "portrait_render" {
  name                  = "${var.project_name}-portrait-render"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.portrait_render.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn
    executionRoleArn = aws_iam_role.batch_execution.arn

    resourceRequirements = [
      { type = "VCPU", value = "1" }, # orchestration only — Modal does the compute
      { type = "MEMORY", value = "2048" }
    ]

    networkConfiguration = { assignPublicIp = "ENABLED" }
    runtimePlatform      = { cpuArchitecture = "X86_64", operatingSystemFamily = "LINUX" }

    # MATCH_SLUG + CLUB_SLUG are injected per-job by SubmitJob containerOverrides.
    # SUPABASE_SERVICE_ROLE_KEY as plaintext env matches the other Batch jobs'
    # accepted surface — the Secrets Manager/SSM swap is blocked on org IAM
    # (playhub-admin lacks CreateSecret/PutParameter, verified 2026-07-13).
    environment = [
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "SUPABASE_SERVICE_ROLE_KEY", value = var.supabase_service_key },
      { name = "MODAL_CROP_URL", value = var.modal_crop_url },
      { name = "MODAL_RENDER_URL", value = var.modal_render_url },
      { name = "MODAL_SHARED_SECRET", value = var.modal_shared_secret },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.portrait_render.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "portrait-render"
      }
    }
  })

  timeout {
    # ~7 goals/match × (detect ~90s + render ~40s + fetches) ≈ 20 min typical.
    attempt_duration_seconds = 3600
  }
  retry_strategy {
    attempts = 2
    evaluate_on_exit {
      on_exit_code = "1"
      action       = "EXIT" # app failure — per-event error rows own retries
    }
    evaluate_on_exit {
      on_reason = "*"
      action    = "RETRY" # infra/placement fault
    }
  }

  tags = { Name = "PLAYHUB Portrait Render Job", Environment = var.environment }
}

resource "aws_iam_role" "codebuild_portrait_render" {
  name = "${var.project_name}-codebuild-portrait-render"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "PLAYHUB Portrait Render CodeBuild", Environment = var.environment }
}

resource "aws_iam_role_policy" "codebuild_portrait_render" {
  name = "${var.project_name}-codebuild-portrait-render"
  role = aws_iam_role.codebuild_portrait_render.id
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
        Resource = aws_ecr_repository.portrait_render.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:aws:s3:::${var.s3_bucket}/codebuild/portrait-render-src.zip"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/codebuild/${var.project_name}-portrait-render-image*"
      },
    ]
  })
}

resource "aws_codebuild_project" "portrait_render_image" {
  name          = "${var.project_name}-portrait-render-image"
  service_role  = aws_iam_role.codebuild_portrait_render.arn
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
      value = aws_ecr_repository.portrait_render.repository_url
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.aws_region
    }
  }

  source {
    type     = "S3"
    location = "${var.s3_bucket}/codebuild/portrait-render-src.zip"
  }

  tags = { Name = "PLAYHUB Portrait Render Image Build", Environment = var.environment }
}

output "portrait_render_job_definition" {
  value = aws_batch_job_definition.portrait_render.name
}
output "portrait_render_ecr_url" {
  value = aws_ecr_repository.portrait_render.repository_url
}
output "portrait_render_codebuild_project" {
  value = aws_codebuild_project.portrait_render_image.name
}
