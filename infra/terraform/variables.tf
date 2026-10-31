variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name, used in resource names (e.g. staging, prod)."
  type        = string
  default     = "staging"
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "image_tag" {
  description = "Tag of the service image in ECR (the same image runs the API, migrations and jobs)."
  type        = string
  default     = "latest"
}

variable "app_desired_count" {
  description = "Number of API tasks. Two or more, in different AZs."
  type        = number
  default     = 2
}

variable "app_cpu" {
  description = "CPU units per task (1024 = 1 vCPU)."
  type        = number
  default     = 512
}

variable "app_memory" {
  description = "Memory per task, in MiB."
  type        = number
  default     = 1024
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage" {
  description = "RDS storage in GiB."
  type        = number
  default     = 50
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener. Required: the API never listens on plain HTTP."
  type        = string
  default     = "arn:aws:acm:us-east-1:000000000000:certificate/replace-me"
}

variable "app_config" {
  description = "Non-secret service settings (see .env.example)."
  type        = map(string)
  default = {
    LOG_LEVEL                        = "info"
    BANK_SIGNATURE_TOLERANCE_SECONDS = "300"
    HOLD_TTL_DAYS                    = "7"
    CLOSING_CAPTURE_WINDOW_DAYS      = "30"
    MIN_DEPOSIT_CENTAVOS             = "50000"
    MAX_AMOUNT_CENTAVOS              = "100000000"
    PAYOUT_STUCK_MINUTES             = "5"
  }
}

variable "job_schedules" {
  description = "EventBridge Scheduler expression per job (src/jobs/cli.ts)."
  type        = map(string)
  default = {
    "expire-holds"      = "rate(15 minutes)"
    "send-payouts"      = "rate(1 hour)"
    "progress-closures" = "rate(1 hour)"
    "reconcile"         = "rate(1 day)"
  }
}
