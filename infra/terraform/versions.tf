# Q29: AWS, described as code, validated in CI, never applied by this repo.
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds generated passwords: keep it in an encrypted, versioned,
  # access-logged bucket with locking. Fill in and uncomment per environment.
  # backend "s3" {
  #   bucket       = "acme-credit-tfstate"
  #   key          = "secured-card/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      service     = "secured-card"
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}
