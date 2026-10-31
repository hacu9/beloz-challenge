# RDS Postgres 16: Multi-AZ, encrypted, private, with backups and deletion
# protection. The app connects as the least-privilege role acme_app; only the
# migration task uses the owner (master) credentials.

resource "random_password" "db_master" {
  length  = 32
  special = false
}

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres16"

  # Every connection uses TLS.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Log statements slower than 500 ms; never log parameters (they hold money data).
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "main" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = "16"
  instance_class               = var.db_instance_class
  allocated_storage            = var.db_allocated_storage
  storage_type                 = "gp3"
  storage_encrypted            = true
  multi_az                     = true
  db_name                      = "acme"
  username                     = "acme_owner"
  password                     = random_password.db_master.result
  db_subnet_group_name         = aws_db_subnet_group.main.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.main.name
  publicly_accessible          = false
  backup_retention_period      = 14
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-final"
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
}
