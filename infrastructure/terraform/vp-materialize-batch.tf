# ─────────────────────────────────────────────────────────────────────────────
# AWS BATCH — VP MATERIALIZE  (extends batch-ball-detection.tf)
#
# Materializes a recording's RAW VirtualPanorama (full-match, multi-GB 4K VOD) and
# remuxes it (-c copy, no re-encode) into our private S3, so the watch-page de-warp
# free-look plays from a signed URL (never Spiideo's JWT-bearing playlist — see the
# A2 security review). On Batch (not Lambda) because the file is too big for a
# 15-min Lambda / its /tmp; FARGATE because the remux is CPU/IO-only (no GPU) and
# Fargate gives configurable ephemeral disk with zero instance management.
#
# Reuses from batch-ball-detection.tf: the default-VPC networking + egress SG, the
# batch_service role, the batch_job role (S3 read/write on the bucket), and the
# batch_execution (ECS task exec) role from batch-precompute.tf. Adds only: an ECR
# repo, a Fargate CE + queue, a job definition, and a log group.
#
# Triggered by POST /api/recordings/[id]/panorama-source via Batch SubmitJob, which
# passes RECORDING_ID + GAME_ID (from OUR DB row) as container env overrides.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "vp_materialize" {
  name                 = "${var.project_name}-vp-materialize"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "PLAYHUB VP Materialize", Environment = var.environment }
}

resource "aws_ecr_lifecycle_policy" "vp_materialize" {
  repository = aws_ecr_repository.vp_materialize.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "vp_materialize" {
  name              = "/aws/batch/${var.project_name}-vp-materialize"
  retention_in_days = 14
  tags              = { Name = "PLAYHUB VP Materialize Logs", Environment = var.environment }
}

# CPU-only Fargate CE — the remux needs no GPU; scales to zero at rest. ON-DEMAND
# (not spot): this is a user-triggered capture with someone waiting, and a spot
# capacity-wait would trip the route's 10-min pending expiry while the job later
# runs and writes 'ready' onto an already-expired row. The ~1¢/capture spot saving
# isn't worth that; storage is the real cost, not compute.
resource "aws_batch_compute_environment" "vp_materialize" {
  compute_environment_name = "${var.project_name}-vp-materialize"
  type                     = "MANAGED"
  state                    = "ENABLED"
  service_role             = aws_iam_role.batch_service.arn

  compute_resources {
    type = "FARGATE"
    # Sized so every job class's in-flight cap can run WITHOUT queueing. Sum the
    # caps whenever a class is added — the comment here was stale at "= 14 ≤ 16"
    # while the CE was already at exactly 16/16, which would have silently queued
    # the next class behind capture work.
    #   vp-materialize 5 × 2 vCPU = 10  (GLOBAL_INFLIGHT_CAP)
    #   aim-track      2 × 2      =  4
    #   portrait       1 × 1      =  1   (see below)
    #   player-tracklets 1 × 1    =  1   -> 16, i.e. FULL before veo-capture
    #   veo-capture    2 × 1      =  2   -> 18
    # 20, not 18: portrait has NO explicit in-flight cap — it holds at 1 only
    # because the sweep breaks after one attempt and index.ts dedupes by slug.
    # Raising PORTRAIT_SWEEP_MAX_PER_RUN would silently make it N-concurrent and
    # overflow the CE. The slack is cheap (Fargate bills running vCPU, not the
    # ceiling; the eu-west-2 On-Demand quota is 64) and this CE has now been found
    # at exactly-full twice in one day. Overflow costs queueing, not failure.
    max_vcpus          = 20
    subnets            = data.aws_subnets.default.ids
    security_group_ids = [aws_security_group.batch.id]
  }

  tags = { Name = "PLAYHUB VP Materialize CE", Environment = var.environment }
}

resource "aws_batch_job_queue" "vp_materialize" {
  name     = "${var.project_name}-vp-materialize-queue"
  state    = "ENABLED"
  priority = 1
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.vp_materialize.arn
  }
  tags = { Name = "PLAYHUB VP Materialize Queue", Environment = var.environment }
}

resource "aws_batch_job_definition" "vp_materialize" {
  name                  = "${var.project_name}-vp-materialize"
  type                  = "container"
  platform_capabilities = ["FARGATE"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.vp_materialize.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn       # S3 read/write on the bucket
    executionRoleArn = aws_iam_role.batch_execution.arn # ECR pull + logs (Fargate)

    resourceRequirements = [
      { type = "VCPU", value = "2" }, # -c copy is network/IO-bound, not CPU
      { type = "MEMORY", value = "4096" }
    ]
    # faststart rewrites the file (moov relocation) → transient ~2× output size on
    # ephemeral disk. 150 GiB gives headroom for a high-bitrate 4K full match.
    ephemeralStorage = { sizeInGiB = 150 }

    # Egress to Spiideo/S3/ECR via the default-VPC public subnets.
    networkConfiguration = { assignPublicIp = "ENABLED" }
    runtimePlatform      = { cpuArchitecture = "X86_64", operatingSystemFamily = "LINUX" }

    # RECORDING_ID + GAME_ID are injected per-job by SubmitJob containerOverrides.
    environment = [
      # MUST equal the app's S3_RECORDINGS_BUCKET (the private bucket getPlaybackUrl
      # signs) — a mismatch 404s every panorama URL, or exposes minors' footage if
      # ever pointed at a public bucket.
      { name = "S3_RECORDINGS_BUCKET", value = var.s3_bucket },
      { name = "VP_S3_PREFIX", value = "panoramas" },
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "SUPABASE_SERVICE_ROLE_KEY", value = var.supabase_service_key },
      { name = "SPIIDEO_PLAY_EMAIL", value = var.spiideo_play_email },
      { name = "SPIIDEO_PLAY_PASSWORD", value = var.spiideo_play_password },
      { name = "SPIIDEO_ACCOUNT_ID", value = var.spiideo_account_id },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.vp_materialize.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "vp-materialize"
      }
    }
  })

  timeout {
    attempt_duration_seconds = 3600 # 1h cap — a full-match remux is I/O-bound, well under
  }
  # Exit-code-driven (NOT the EC2 "Host EC2*" status-reason match, which never fires
  # on Fargate → would disable retry entirely). entrypoint.mjs sets exit code 1 only
  # on a genuine app failure; infra faults (task placement, reclamation) get retried.
  retry_strategy {
    attempts = 2
    evaluate_on_exit {
      on_exit_code = "1"
      action       = "EXIT" # real app failure — don't waste a retry
    }
    evaluate_on_exit {
      on_reason = "*"
      action    = "RETRY" # infra/placement fault — retry
    }
  }

  tags = { Name = "PLAYHUB VP Materialize Job", Environment = var.environment }
}

output "vp_materialize_ecr_url" {
  value = aws_ecr_repository.vp_materialize.repository_url
}
output "vp_materialize_job_queue" {
  value = aws_batch_job_queue.vp_materialize.name
}
output "vp_materialize_job_definition" {
  value = aws_batch_job_definition.vp_materialize.name
}
