# Every secret lives in Secrets Manager and reaches the tasks as an env var
# through the ECS task definition. Nothing secret is in an image or in
# app_config. Rotate the JWT, network and bank secrets with the partners.

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_password" "network_key" {
  length  = 48
  special = false
}

resource "random_password" "bank_webhook" {
  length  = 64
  special = false
}

locals {
  db_host = aws_db_instance.main.address
  secrets = {
    DATABASE_URL           = "postgres://acme_app:${random_password.db_app.result}@${local.db_host}:5432/acme?sslmode=require"
    MIGRATION_DATABASE_URL = "postgres://acme_owner:${random_password.db_master.result}@${local.db_host}:5432/acme?sslmode=require"
    APP_DB_PASSWORD        = random_password.db_app.result
    JWT_SECRET             = random_password.jwt.result
    NETWORK_API_KEY        = random_password.network_key.result
    BANK_WEBHOOK_SECRET    = random_password.bank_webhook.result
  }
  # Which task gets which secret: the API and the jobs never see the owner credentials.
  app_secrets     = ["DATABASE_URL", "JWT_SECRET", "NETWORK_API_KEY", "BANK_WEBHOOK_SECRET"]
  migrate_secrets = ["MIGRATION_DATABASE_URL", "APP_DB_PASSWORD"]
}

resource "aws_secretsmanager_secret" "service" {
  for_each                = local.secrets
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "service" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.service[each.key].id
  secret_string = each.value
}
