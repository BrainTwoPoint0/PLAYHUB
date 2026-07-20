# ─────────────────────────────────────────────────────────────────────────────
# AWS BATCH — JERSEY LABELS  (Tier-3 identity for the /watch Spotlight)
#
# Downstream of player-tracklets: reconstructs the exact production chains
# from archived provenance, reads jersey numbers off the banked raw panorama
# (YOLO + PARSeq + legibility, CPU torch), assembles (number, kit) identity
# slots, and republishes the enriched tracklets.json. Organized-kit venues
# only (JERSEY_VENUES allowlist on the sweep; empty = disabled).
#
# OWN compute environment + queue, deliberately NOT the shared vp-materialize
# CE: this job wants 8 vCPU (the shared CE is budgeted to its committed job
# classes, and resizing it means applying a pre-existing resource in a state
# file with known unapplied drift — all-new resources keep -target applies
# surgical). In-flight cap 1 in the sweep makes max_vcpus=8 the hard ceiling.
#
# No Spiideo/Veo credentials: inputs are exclusively our own S3 artifacts.
# ─────────────────────────────────────────────────────────────────────────────

variable "jersey_venues" {
  description = "Comma-separated Spiideo scene-id allowlist for the jersey-labels sweep (organized-kit venues only; empty = disabled)"
  type        = string
  default     = ""
}

resource "aws_ecr_repository" "jersey_labels" {
  name                 = "${var.project_name}-jersey-labels"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "PLAYHUB Jersey Labels", Environment = var.environment }
}

resource "aws_ecr_lifecycle_policy" "jersey_labels" {
  repository = aws_ecr_repository.jersey_labels.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "jersey_labels" {
  name              = "/aws/batch/${var.project_name}-jersey-labels"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB Jersey Labels Logs", Environment = var.environment }
}

# Dedicated CPU Fargate CE — scales to zero at rest; ON-DEMAND like the rest
# of the pipeline (a nightly-cadence enrichment job, capacity-wait is fine but
# spot interruption mid-90-min-run wastes the whole attempt).
resource "aws_batch_compute_environment" "jersey_labels" {
  compute_environment_name = "${var.project_name}-jersey-labels"
  type                     = "MANAGED"
  state                    = "ENABLED"
  service_role             = aws_iam_role.batch_service.arn

  compute_resources {
    type = "FARGATE"
    # Exactly one job's worth: the sweep's JERSEY_INFLIGHT_CAP=1 × 8 vCPU.
    # Raise both together or the second job silently queues.
    max_vcpus          = 8
    subnets            = data.aws_subnets.default.ids
    security_group_ids = [aws_security_group.batch.id]
  }

  tags = { Name = "PLAYHUB Jersey Labels CE", Environment = var.environment }
}

resource "aws_batch_job_queue" "jersey_labels" {
  name     = "${var.project_name}-jersey-labels-queue"
  state    = "ENABLED"
  priority = 1
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.jersey_labels.arn
  }
  tags = { Name = "PLAYHUB Jersey Labels Queue", Environment = var.environment }
}

resource "aws_batch_job_definition" "jersey_labels" {
  name                  = "${var.project_name}-jersey-labels"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.jersey_labels.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn       # S3 read/write on the bucket
    executionRoleArn = aws_iam_role.batch_execution.arn # ECR pull + logs (Fargate)

    resourceRequirements = [
      # 8 vCPU: ~850 windowed yolov8x@1280 CPU inferences + PARSeq/legibility
      # batches — the wall-clock driver. 16 GiB: torch + a 4K frame + batch
      # tensors; an OOM is a SIGKILL that skips the SIGTERM status write.
      { type = "VCPU", value = "8" },
      { type = "MEMORY", value = "16384" }
    ]
    # The raw panorama is downloaded ONCE to ephemeral disk (a full-match 4K
    # stacked panorama runs 10-40 GB; ~2700 remote per-frame seeks would
    # dominate the runtime and add 2700 transient-failure chances).
    ephemeralStorage = { sizeInGiB = 100 }

    networkConfiguration = { assignPublicIp = "ENABLED" }
    runtimePlatform      = { cpuArchitecture = "X86_64", operatingSystemFamily = "LINUX" }

    # RECORDING_ID + GAME_ID are injected per-job by SubmitJob containerOverrides.
    # Same plaintext-secret surface as the sibling job defs (Secrets Manager
    # swap blocked on org IAM). No third-party credentials at all.
    environment = [
      { name = "S3_RECORDINGS_BUCKET", value = var.s3_bucket },
      { name = "VP_S3_PREFIX", value = "panoramas" },
      { name = "WEIGHTS_S3_PREFIX", value = "provenance/jersey-reader/2026-07-16-probe" },
      # sha256 pins for the three checkpoints the job downloads — computed
      # from the local originals at build time; integrity, not RCE (both
      # torch loads are weights_only=True).
      { name = "PARSEQ_SHA256", value = "c4fa39c4951edb0aa9d49a5c4cbd042761a421baccc23ae11afb1381be13f027" },
      { name = "LEGIBILITY_SHA256", value = "b9c61dabaea4a6ec99528c5ae394f5875aecb8207de38484eccb0f977a373e41" },
      { name = "YOLO_SHA256", value = "3df4ada6b4dad6d657868f2fdf7faecfb34dcfccf3a25c4b82079064718524c8" },
      # 2s (was 4s): ~2x play-anchored reads to raise slot coverage — the
      # crossing successor is far more often labelled, and denser reads feed
      # slot propagation more anchors. ~45min -> ~90min wall-clock, well under
      # the 4h cap. Env-only: applied via a -target job-definition apply, no
      # image rebuild.
      { name = "JERSEY_HARVEST_STEP_S", value = "2.0" },
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "SUPABASE_SERVICE_ROLE_KEY", value = var.supabase_service_key },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.jersey_labels.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "jersey-labels"
      }
    }
  })

  timeout {
    # ~60-90 min measured budget at the 4s step; 4h covers the 2s-step future
    # and a slow panorama download without letting a wedged job hold the CE.
    attempt_duration_seconds = 14400
  }
  retry_strategy {
    # attempts=1: the sweep owns ALL retries (veo-capture lesson — a Batch
    # timeout exits 137, not 1, and would fall through any on_exit_code=1
    # rule into a Batch-level retry racing the sweep's attempt accounting).
    attempts = 1
  }

  tags = { Name = "PLAYHUB Jersey Labels Job", Environment = var.environment }
}

# CodeBuild project to build + push the image (no local Docker needed).
# Source-zip flow: zip infrastructure/batch/jersey-labels/ PLUS
# ../player-tracklets/build_track.py + mesh_rays.py (single-source shared
# modules) → s3://{bucket}/codebuild/jersey-labels-src.zip → start-build.
resource "aws_iam_role" "codebuild_jersey_labels" {
  name = "${var.project_name}-codebuild-jersey-labels"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "PLAYHUB Jersey Labels CodeBuild", Environment = var.environment }
}

resource "aws_iam_role_policy" "codebuild_jersey_labels" {
  name = "${var.project_name}-codebuild-jersey-labels"
  role = aws_iam_role.codebuild_jersey_labels.id
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
        Resource = aws_ecr_repository.jersey_labels.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:aws:s3:::${var.s3_bucket}/codebuild/jersey-labels-src.zip"
      },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/codebuild/${var.project_name}-jersey-labels-image*"
      },
    ]
  })
}

resource "aws_codebuild_project" "jersey_labels_image" {
  name          = "${var.project_name}-jersey-labels-image"
  service_role  = aws_iam_role.codebuild_jersey_labels.arn
  build_timeout = 45 # torch CPU wheels make this a bigger image than siblings

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
      value = aws_ecr_repository.jersey_labels.repository_url
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.aws_region
    }
  }

  source {
    type     = "S3"
    location = "${var.s3_bucket}/codebuild/jersey-labels-src.zip"
  }

  tags = { Name = "PLAYHUB Jersey Labels Image Build", Environment = var.environment }
}

output "jersey_labels_ecr_url" {
  value = aws_ecr_repository.jersey_labels.repository_url
}
output "jersey_labels_job_definition" {
  value = aws_batch_job_definition.jersey_labels.name
}
output "jersey_labels_codebuild_project" {
  value = aws_codebuild_project.jersey_labels_image.name
}
output "jersey_labels_queue" {
  value = aws_batch_job_queue.jersey_labels.name
}
