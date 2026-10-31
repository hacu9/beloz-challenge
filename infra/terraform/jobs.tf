# Scheduled jobs (architecture §11) run as one-off Fargate tasks from the same
# image. Each job takes the account row lock like any writer, so a slow run
# overlapping the next one is safe, only wasteful.

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_run_task" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.service["jobs"].arn_without_revision, "${aws_ecs_task_definition.service["jobs"].arn_without_revision}:*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "run-job-tasks"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_run_task.json
}

resource "aws_scheduler_schedule" "job" {
  for_each            = var.job_schedules
  name                = "${local.name}-${each.key}"
  schedule_expression = each.value

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.service["jobs"].arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.tasks.id]
        assign_public_ip = false
      }
    }

    # The job name is the container's argument: node dist/jobs/cli.js <job>.
    input = jsonencode({
      containerOverrides = [{ name = "jobs", command = ["node", "dist/jobs/cli.js", each.key] }]
    })

    # A failed or skipped run is not retried here: the next tick runs the same
    # idempotent step. reconcile exits non-zero on drift; alarm on that.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# reconcile exits non-zero on any mismatch (OPS-03); its log line says
# "job failed". Page someone when that happens.
resource "aws_cloudwatch_log_metric_filter" "job_failed" {
  name           = "${local.name}-job-failed"
  log_group_name = aws_cloudwatch_log_group.service.name
  pattern        = "{ $.msg = \"job failed\" }"

  metric_transformation {
    name      = "JobFailed"
    namespace = "AcmeCard/${var.environment}"
    value     = "1"
  }
}

# Review F5: an alarm with no action pages nobody.
resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "job_failed" {
  alarm_name          = "${local.name}-job-failed"
  namespace           = "AcmeCard/${var.environment}"
  metric_name         = "JobFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  alarm_description   = "A scheduled job (often reconcile) reported a failure. Check the books before anything else."
}
