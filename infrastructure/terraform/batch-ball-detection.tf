# ============================================================================
# AWS BATCH — BALL DETECTION (GPU)
# Runs YOLOv8m + Norfair on spot g4dn.xlarge (T4 GPU).
# Scales to 0 when idle — $0/month at rest.
# ============================================================================

# ----------------------------------------------------------------------------
# ECR Repository
# ----------------------------------------------------------------------------

resource "aws_ecr_repository" "ball_detection" {
  name                 = "${var.project_name}-ball-detection"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name        = "PLAYHUB Ball Detection"
    Environment = var.environment
  }
}

resource "aws_ecr_lifecycle_policy" "ball_detection" {
  repository = aws_ecr_repository.ball_detection.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 5 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# ----------------------------------------------------------------------------
# IAM Roles
# ----------------------------------------------------------------------------

# Batch Service Role — lets AWS Batch manage EC2 instances
resource "aws_iam_role" "batch_service" {
  name = "${var.project_name}-batch-service-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "batch.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "PLAYHUB Batch Service Role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "batch_service" {
  role       = aws_iam_role.batch_service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"
}

# ECS Instance Role — EC2 instances register with ECS and pull from ECR
resource "aws_iam_role" "batch_instance" {
  name = "${var.project_name}-batch-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "PLAYHUB Batch Instance Role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "batch_instance_ecs" {
  role       = aws_iam_role.batch_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "batch_instance" {
  name = "${var.project_name}-batch-instance-profile"
  role = aws_iam_role.batch_instance.name
}

# Job Execution Role — container gets S3 read/write access
resource "aws_iam_role" "batch_job" {
  name = "${var.project_name}-batch-job-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "PLAYHUB Batch Job Role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy" "batch_job_s3" {
  name = "${var.project_name}-batch-job-s3"
  role = aws_iam_role.batch_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = "arn:aws:s3:::${var.s3_bucket}/*"
      }
    ]
  })
}

# ECR pull policy for job execution role
resource "aws_iam_role_policy" "batch_job_ecr" {
  name = "${var.project_name}-batch-job-ecr"
  role = aws_iam_role.batch_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = "*"
      }
    ]
  })
}

# CloudWatch Logs policy for job execution role
resource "aws_iam_role_policy" "batch_job_logs" {
  name = "${var.project_name}-batch-job-logs"
  role = aws_iam_role.batch_job.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.ball_detection.arn}:*"
      }
    ]
  })
}

# ----------------------------------------------------------------------------
# Networking — Default VPC
# ----------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "batch" {
  name_prefix = "${var.project_name}-batch-"
  description = "Ball detection Batch - egress only (S3, ECR, CloudWatch)"
  vpc_id      = data.aws_vpc.default.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "PLAYHUB Batch Security Group"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# Batch Compute Environment — Spot g4dn.xlarge (T4 GPU)
# ----------------------------------------------------------------------------

resource "aws_batch_compute_environment" "ball_detection" {
  compute_environment_name = "${var.project_name}-ball-detection"
  type                     = "MANAGED"
  state                    = "ENABLED"
  service_role             = aws_iam_role.batch_service.arn

  compute_resources {
    type                = "SPOT"
    bid_percentage      = 80
    spot_iam_fleet_role = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-ec2-spot-fleet-tagging-role"

    min_vcpus = 0
    max_vcpus = 8

    instance_type = ["g4dn.xlarge"]

    subnets            = data.aws_subnets.default.ids
    security_group_ids = [aws_security_group.batch.id]
    instance_role      = aws_iam_instance_profile.batch_instance.arn

    tags = {
      Name        = "PLAYHUB Ball Detection"
      Environment = var.environment
    }
  }

  tags = {
    Name        = "PLAYHUB Ball Detection CE"
    Environment = var.environment
  }
}

data "aws_caller_identity" "current" {}

# ----------------------------------------------------------------------------
# Batch Job Queue
# ----------------------------------------------------------------------------

resource "aws_batch_job_queue" "ball_detection" {
  name     = "${var.project_name}-ball-detection-queue"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.ball_detection.arn
  }

  tags = {
    Name        = "PLAYHUB Ball Detection Queue"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# Batch Job Definition
# ----------------------------------------------------------------------------

resource "aws_batch_job_definition" "ball_detection" {
  name = "${var.project_name}-ball-detection"
  type = "container"

  platform_capabilities = ["EC2"]

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.ball_detection.repository_url}:latest"
    jobRoleArn       = aws_iam_role.batch_job.arn
    executionRoleArn = aws_iam_role.batch_job.arn

    resourceRequirements = [
      { type = "VCPU", value = "4" },
      { type = "MEMORY", value = "15360" },
      { type = "GPU", value = "1" }
    ]

    environment = [
      { name = "S3_BUCKET", value = var.s3_bucket }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ball_detection.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ball-detection"
      }
    }
  })

  timeout {
    attempt_duration_seconds = 600
  }

  retry_strategy {
    attempts = 3

    evaluate_on_exit {
      on_status_reason = "Host EC2*"
      action           = "RETRY"
    }

    evaluate_on_exit {
      on_exit_code = 1
      action       = "EXIT"
    }
  }

  tags = {
    Name        = "PLAYHUB Ball Detection Job"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# CloudWatch Logs
# ----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "ball_detection" {
  name              = "/aws/batch/${var.project_name}-ball-detection"
  retention_in_days = 14

  tags = {
    Name        = "PLAYHUB Ball Detection Logs"
    Environment = var.environment
  }
}

# ----------------------------------------------------------------------------
# Outputs
# ----------------------------------------------------------------------------

output "ball_detection_ecr_url" {
  value       = aws_ecr_repository.ball_detection.repository_url
  description = "ECR repository URL for ball detection image"
}

output "ball_detection_job_queue" {
  value       = aws_batch_job_queue.ball_detection.name
  description = "Batch job queue name"
}

output "ball_detection_job_definition" {
  value       = aws_batch_job_definition.ball_detection.name
  description = "Batch job definition name"
}
