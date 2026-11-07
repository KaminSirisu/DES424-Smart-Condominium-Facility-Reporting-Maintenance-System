# Infrastructure

The first SCFRMS backend deployment is defined in [`aws/`](aws/README.md) with AWS CDK. It currently uses API Gateway HTTP API and Node.js Lambda. The team's original ECR/ECS/Fargate design is documented as an [alternative API deployment](../docs/architecture/deployment-topology.md); it needs an HTTP server and container build before the backend can run in ECS. The staff portal is a separate possible container deployment for the course bonus.

`docker/` remains available for local containers or a later staff portal image.

Do not commit credentials or generated deployment artifacts.
