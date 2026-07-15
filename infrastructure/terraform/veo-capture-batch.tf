# ============================================================================
# VEO CAPTURE — preserve the native panorama + jersey labels before Glacier
# ============================================================================
# Veo is the free LABELLER for our OWN jersey model (production must never call
# their AI). Their /api/mes/v2/player-tracking serves jersey-labelled metric
# player tracks — a 92.1% read rate — which is the training corpus we would
# otherwise pay to hand-label. But that corpus is only usable while the PIXELS
# exist, and the pixels expire: measured 2026-07-15, the native .ts panorama is
# `available` at <=40d and Glacier'd (`InvalidObjectState`) by ~150d.
#
# Same trap as the Spiideo raw-VP purge that cost us 234/268 panoramas, so it
# gets the same answer: capture on publish.
#
# Runs on the SHARED vp-materialize CE/queue. Its 2 × 1 vCPU in-flight cap is
# already counted in that CE's max_vcpus (raised 16 -> 18 for this class).

resource "aws_ecr_repository" "veo_capture" {
  name                 = "${var.project_name}-veo-capture"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  tags = { Name = "PLAYHUB Veo Capture", Environment = var.environment }
}

resource "aws_ecr_lifecycle_policy" "veo_capture" {
  repository = aws_ecr_repository.veo_capture.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 5"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "veo_capture" {
  name              = "/aws/batch/${var.project_name}-veo-capture"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB Veo Capture Logs", Environment = var.environment }
}

resource "aws_batch_job_definition" "veo_capture" {
  name                  = "${var.project_name}-veo-capture"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.veo_capture.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn       # S3 read/write on the bucket
    executionRoleArn = aws_iam_role.batch_execution.arn # ECR pull + logs (Fargate)

    resourceRequirements = [
      # Network-bound: a ~9.5GB byte-for-byte copy from a public CDN into S3,
      # plus one headless-chromium login. No transcode, no re-encode.
      { type = "VCPU", value = "1" },
      # 2048 covers chromium (~500MB peak) + the multipart buffer
      # (partSize 32MB × queueSize 4 ≈ 128MB). A Fargate OOM is a SIGKILL that
      # skips the status write and wastes a retry, so do not trim this.
      { type = "MEMORY", value = "2048" }
    ]
    # NO ephemeralStorage override: unlike vp-materialize (which must stage an
    # HLS remux to /tmp), the .ts is a progressive object streamed fetch -> S3.
    # Nothing touches disk, so the Fargate default 20 GiB is ample for a 9.5GB
    # transfer.

    networkConfiguration = { assignPublicIp = "ENABLED" }
    runtimePlatform      = { cpuArchitecture = "X86_64", operatingSystemFamily = "LINUX" }

    # ROW_ID + MATCH_SLUG are injected per-job by SubmitJob containerOverrides.
    # Plaintext secrets match the accepted vp-materialize/aim-track/tracklets
    # surface — the Secrets Manager swap is BLOCKED on org IAM (playhub-admin
    # lacks secretsmanager:CreateSecret); swap all job defs together once granted.
    # VEO_EMAIL/VEO_PASSWORD are the same single shared account the veo-sync
    # Lambda already uses.
    environment = [
      { name = "S3_RECORDINGS_BUCKET", value = var.s3_bucket },
      { name = "VEO_S3_PREFIX", value = "veo-panoramas" },
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "SUPABASE_SERVICE_ROLE_KEY", value = var.supabase_service_key },
      { name = "VEO_EMAIL", value = var.veo_email },
      { name = "VEO_PASSWORD", value = var.veo_password },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.veo_capture.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "veo-capture"
      }
    }
  })

  timeout {
    # A 9.5GB transfer is minutes at Fargate egress, but Veo's CDN can be slow.
    # 1h is generous and still bounds a wedged socket from holding a queue slot.
    attempt_duration_seconds = 3600
  }
  # attempts = 1: the SWEEP owns retries, exclusively.
  #
  # The sibling classes use attempts = 2, but here that races the sweep. A timeout
  # or a Fargate OOM exits 137 — not 1 — so it falls through to `on_reason = "*"`
  # -> RETRY. With attempt_duration_seconds = 3600 and VEO_CAPTURE_STUCK_MS = 1h,
  # at t=1h Batch would start attempt 2 while the sweep simultaneously sees a stale
  # `pending` and submits a fresh job: two jobs, same match, ~9.5GB each, and the
  # job names are per-row so no ListJobs guard catches it. Letting Batch retry also
  # doubles the worst-case row lifetime to 2h on a CE with two slots.
  retry_strategy {
    attempts = 1
  }

  tags = { Name = "PLAYHUB Veo Capture Job", Environment = var.environment }
}

# ── image build ─────────────────────────────────────────────────────────────
# Source-zip flow, identical to the other job classes:
#   zip infrastructure/batch/veo-capture/ →
#   s3://{bucket}/codebuild/veo-capture-src.zip → start-build.
# The job def pins :latest, so a rebuild+push is picked up by the next SubmitJob
# with no terraform apply.
#
# Its own service role, NOT a reuse of codebuild_player_tracklets. That role's
# policy is resource-scoped — ECR repo, the exact src.zip key, and the log group
# are each pinned to `player-tracklets` — so reusing it needs three separate
# widenings and quietly turns a least-privilege role into a shared one. (Tried it:
# the first build died on `logs:CreateLogStream` for the veo-capture log group.)
# A per-class role keeps each build able to touch only its own artifacts.
resource "aws_iam_role" "codebuild_veo_capture" {
  name = "${var.project_name}-codebuild-veo-capture"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "PLAYHUB Veo Capture CodeBuild", Environment = var.environment }
}

resource "aws_iam_role_policy" "codebuild_veo_capture" {
  name = "${var.project_name}-codebuild-veo-capture"
  role = aws_iam_role.codebuild_veo_capture.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*" # GetAuthorizationToken has no resource-level permissions
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
        Resource = aws_ecr_repository.veo_capture.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:aws:s3:::${var.s3_bucket}/codebuild/veo-capture-src.zip"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/codebuild/${var.project_name}-veo-capture-image*"
      },
    ]
  })
}

resource "aws_codebuild_project" "veo_capture_image" {
  name          = "${var.project_name}-veo-capture-image"
  service_role  = aws_iam_role.codebuild_veo_capture.arn
  build_timeout = 30 # the Playwright base image is ~1.5GB to pull

  artifacts { type = "NO_ARTIFACTS" }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true # docker build

    environment_variable {
      name  = "ECR_REPO_URL"
      value = aws_ecr_repository.veo_capture.repository_url
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.aws_region
    }
  }

  source {
    type     = "S3"
    location = "${var.s3_bucket}/codebuild/veo-capture-src.zip"
  }

  tags = { Name = "PLAYHUB Veo Capture Image Build", Environment = var.environment }
}

output "veo_capture_job_definition" {
  value = aws_batch_job_definition.veo_capture.name
}
output "veo_capture_codebuild_project" {
  value = aws_codebuild_project.veo_capture_image.name
}
