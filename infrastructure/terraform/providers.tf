# Terraform configuration for PLAYHUB sync infrastructure

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# us-east-1 alias for global AWS services (Budgets, Cost Explorer, Cost Anomaly Detection)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# Common variables
variable "aws_region" {
  default = "eu-west-2"
}

variable "environment" {
  default = "production"
}

variable "project_name" {
  default = "playhub"
}
