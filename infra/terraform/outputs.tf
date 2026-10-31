output "api_dns_name" {
  description = "Load balancer DNS name; point the API domain here."
  value       = aws_lb.main.dns_name
}

output "ecr_repository_url" {
  description = "Push the service image here."
  value       = aws_ecr_repository.service.repository_url
}

output "migrate_task_definition" {
  description = "Run this task once before each service update (see docs/deployment.md)."
  value       = aws_ecs_task_definition.service["migrate"].arn
}

output "db_endpoint" {
  description = "Private RDS endpoint."
  value       = aws_db_instance.main.address
}
