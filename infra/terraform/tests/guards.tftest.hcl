# terraform test with mocked providers: no AWS credentials, nothing created.
# Proves the review guards (F1, F5, H4, H5) that `terraform validate` cannot see.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "random" {}

variables {
  alert_email = "oncall@example.com"
}

run "default_config_plans" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.job_failed.alarm_actions) == 1
    error_message = "The job-failure alarm must notify the alerts topic (F5)."
  }

  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == "oncall@example.com"
    error_message = "The alerts topic must have a subscriber (H5)."
  }

  assert {
    condition     = aws_db_instance.main.publicly_accessible == false && aws_db_instance.main.storage_encrypted
    error_message = "The database must be private and encrypted."
  }
}

run "secret_key_in_app_config_is_refused" {
  command = plan
  variables {
    app_config = {
      LOG_LEVEL           = "info"
      BANK_WEBHOOK_SECRET = "oops"
    }
  }
  expect_failures = [var.app_config]
}

run "unknown_key_in_app_config_is_refused" {
  command = plan
  variables {
    app_config = {
      LOG_LEVEL = "info"
      FEATURE_X = "1"
    }
  }
  expect_failures = [var.app_config]
}

run "secret_as_a_value_is_refused" {
  command = plan
  variables {
    app_config = {
      LOG_LEVEL = "sk_live_51HxyzSECRETVALUE"
    }
  }
  expect_failures = [var.app_config]
}

run "missing_alert_target_is_refused" {
  command = plan
  variables {
    alert_email = ""
  }
  expect_failures = [var.alert_email]
}
