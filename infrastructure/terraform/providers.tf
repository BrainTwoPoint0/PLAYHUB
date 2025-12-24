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
