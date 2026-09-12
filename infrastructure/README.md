# Infrastructure

`aws/` will hold the chosen infrastructure-as-code configuration for the required AWS deployment. Expected resources include API Gateway, Lambda, DynamoDB, S3, and permissions. Add the actual definitions only after the deployment tool is selected.

`docker/` is reserved for local container configuration. If the team pursues the container bonus, add the admin portal's Dockerfile in `frontend/admin-dashboard/` and ECS Fargate/ECR resources here or under `aws/`, with a tested deployment workflow.

Do not commit credentials or generated deployment artifacts.
