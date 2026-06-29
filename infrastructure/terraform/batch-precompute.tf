# ─────────────────────────────────────────────────────────────────────────────
# AWS BATCH — GOAL PRECOMPUTE  (extends batch-ball-detection.tf)
#
# Bulk-detects the ~4,920 uncached "goal" highlights on spot GPU and UPSERTs the
# results into playhub_crop_detections (Supabase) so the editor loads them
# instantly. Reuses the compute environment + queue + ECR repo + job role defined
# in batch-ball-detection.tf; adds only what precompute needs: a Secrets-Manager
# secret for the Supabase key, an execution role to inject it, and a job def.
#
# NOTE: before `apply`, also bump the compute environment in batch-ball-detection.tf
# for throughput + the 25fps clips (verify arg names against your provider version):
#     instance_type        = ["g5.xlarge", "g6.xlarge"]
#     allocation_strategy  = "SPOT_CAPACITY_OPTIMIZED"
#     max_vcpus            = 128   # ~32 concurrent single-GPU instances
#     min_vcpus            = 0     # scale to zero when idle
# and ensure the CE uses GPU-optimized (ECS_AL2_NVIDIA) AMI instances.
# ─────────────────────────────────────────────────────────────────────────────

# ── Supabase service-role key via Secrets Manager (never plaintext env) ──
resource "aws_secretsmanager_secret" "supabase_service_key" {
  name = "${var.project_name}/ball-precompute/supabase-service-role-key"
  tags = { Project = var.project_name, Environment = var.environment }
}

resource "aws_secretsmanager_secret_version" "supabase_service_key" {
  secret_id     = aws_secretsmanager_secret.supabase_service_key.id
  secret_string = var.supabase_service_key
}

# ── Execution role — resolves the `secrets` injection at container start. The job
#    role (batch_job) is what detect_ball/entrypoint use at RUNTIME; this one only
#    pulls the image, writes logs, and reads the one secret. ──
resource "aws_iam_role" "batch_execution" {
  name = "${var.project_name}-batch-execution-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Project = var.project_name, Environment = var.environment }
}

resource "aws_iam_role_policy_attachment" "batch_execution_ecs" {
  role       = aws_iam_role.batch_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "batch_execution_secret" {
  name = "${var.project_name}-batch-execution-secret"
  role = aws_iam_role.batch_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_secretsmanager_secret.supabase_service_key.arn
    }]
  })
}

# ── Precompute job definition (reuses the CE + queue from batch-ball-detection.tf).
#    Submitted as an ARRAY job; each task reads its shard of the S3 manifest. ──
resource "aws_batch_job_definition" "ball_precompute" {
  name                  = "${var.project_name}-ball-precompute"
  type                  = "container"
  platform_capabilities = ["EC2"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.ball_detection.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn
    executionRoleArn = aws_iam_role.batch_execution.arn
    resourceRequirements = [
      { type = "VCPU", value = "4" },
      # 14000 MiB, not the full 16384 — leave headroom or Batch can't place the job.
      { type = "MEMORY", value = "14000" },
      { type = "GPU", value = "1" }
    ]
    environment = [
      { name = "S3_BUCKET", value = var.s3_bucket },
      { name = "SUPABASE_URL", value = var.supabase_url },
      { name = "OUTPUT_FPS", value = "25" },
      { name = "SHARD_SIZE", value = "20" },
      { name = "RESULTS_S3_PREFIX", value = "ball-detection/precompute-results" }
    ]
    secrets = [
      { name = "SUPABASE_SERVICE_ROLE_KEY", valueFrom = aws_secretsmanager_secret.supabase_service_key.arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"  = "/aws/batch/${var.project_name}-ball-detection"
        "awslogs-region" = var.aws_region
      }
    }
  })

  # Retry spot reclamation (Host EC2*) but EXIT on a real code failure.
  retry_strategy {
    attempts = 3
    evaluate_on_exit {
      action           = "RETRY"
      on_status_reason = "Host EC2*"
    }
    evaluate_on_exit {
      action    = "EXIT"
      on_reason = "*"
    }
  }

  timeout {
    attempt_duration_seconds = 2700 # 20 clips/shard × ~98s ≈ 33 min; 45 min cap
  }

  tags = { Project = var.project_name, Environment = var.environment }
}

output "ball_precompute_job_definition" {
  value = aws_batch_job_definition.ball_precompute.name
}
