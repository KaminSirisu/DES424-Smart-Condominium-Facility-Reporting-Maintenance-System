# Staff portal container deployment

This is a separate CDK app from `Des424G02ScfrmsDev`. It does not change the
Lambda API stack. Deploy `Des424G02StaffImage` first to create a private ECR
repository. Build and push the image, then deploy `Des424G02StaffPortal`.

The portal stack runs one Linux x86-64 Fargate task (0.25 vCPU, 512 MiB) in a
two-AZ public VPC with no NAT gateway. An Application Load Balancer accepts
requests only from the AWS-managed CloudFront origin-facing prefix list.
CloudFront provides a public HTTPS URL without a custom domain. The ALB serves
only the public static site; the browser sends login and other API requests
directly to HTTPS API Gateway. The ALB and Fargate task run continuously until
the portal stack is deleted or the service is scaled down.

## 1. Refresh CloudShell and create the image repository

Run in the group's `ap-southeast-1` CloudShell after this branch is merged:

```sh
cd ~/scfrms-g02
git fetch origin main
git switch --detach FETCH_HEAD
test "$(aws sts get-caller-identity --query Account --output text)" = 528301714999
test -f frontend/admin-dashboard/Dockerfile
test -f infrastructure/aws/bin/staff-app.ts
df -h "$HOME" /tmp
npm run infra:staff:diff -- Des424G02StaffImage --method template
npm run infra:staff:deploy -- Des424G02StaffImage --require-approval never
```

The image stack should add one ECR repository. It has no ECS service and no
changes to the backend stack. If CDK cannot create `cdk.out`, remove only the
generated `infrastructure/aws/cdk.out` and create the directory again.

## 2. Build and push the exact merged revision

Run from the same repository root. The tag is the 12-character Git commit SHA,
so every deployed image can be traced to source. The API URL is public browser
configuration; never pass credentials as a Docker build argument.

```sh
STAFF_REPO_URI=$(aws ecr describe-repositories \
  --repository-names des424-g02-scfrms-staff \
  --region ap-southeast-1 \
  --query 'repositories[0].repositoryUri' --output text)
STAFF_IMAGE_TAG=$(git rev-parse --short=12 HEAD)
docker build --platform linux/amd64 \
  -f frontend/admin-dashboard/Dockerfile \
  --build-arg VITE_API_BASE_URL=https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1 \
  -t "${STAFF_REPO_URI}:${STAFF_IMAGE_TAG}" .
aws ecr get-login-password --region ap-southeast-1 |
  docker login --username AWS --password-stdin "${STAFF_REPO_URI%%/*}"
docker push "${STAFF_REPO_URI}:${STAFF_IMAGE_TAG}"
aws ecr describe-images --repository-name des424-g02-scfrms-staff \
  --image-ids "imageTag=${STAFF_IMAGE_TAG}" --region ap-southeast-1 \
  --query 'imageDetails[0].[imageTags[0],imageSizeInBytes]' --output table
```

CloudShell supports Docker, but its persistent home directory is small. The
root `.dockerignore` keeps `node_modules`, CDK output and local `.env` files
out of the Docker build context. Do not run `npm ci` again unless dependencies
are missing.

## 3. Review and deploy the HTTPS portal

Find the regional AWS-managed CloudFront prefix list and verify that the two
availability zones used by the VPC are enabled:

```sh
CF_PREFIX_LIST_ID=$(aws ec2 describe-managed-prefix-lists \
  --region ap-southeast-1 \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)
printf 'CloudFront prefix list: %s\n' "$CF_PREFIX_LIST_ID"
aws ec2 describe-availability-zones --region ap-southeast-1 \
  --query 'AvailabilityZones[].[ZoneName,State]' --output table
npm run infra:staff:diff -- Des424G02StaffPortal --method template \
  -c "staffImageTag=${STAFF_IMAGE_TAG}" \
  -c "cloudFrontPrefixListId=${CF_PREFIX_LIST_ID}"
```

The diff should create a VPC, two public subnets, an internet gateway, an ECS
cluster/service/task, one ALB, CloudWatch logs, and one CloudFront distribution.
It should not change DynamoDB, S3 uploads, the Lambda API or LINE/SES secrets.
If the prefix list is `None`, an availability zone is not enabled, or the diff
includes other resources, stop and inspect it before deploying.

```sh
npm run infra:staff:deploy -- Des424G02StaffPortal --require-approval never \
  -c "staffImageTag=${STAFF_IMAGE_TAG}" \
  -c "cloudFrontPrefixListId=${CF_PREFIX_LIST_ID}"
STAFF_ORIGIN=$(aws cloudformation describe-stacks \
  --stack-name Des424G02StaffPortal --region ap-southeast-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`StaffPortalUrl`].OutputValue | [0]' \
  --output text)
printf 'Staff site: %s\n' "$STAFF_ORIGIN"
curl -fsS "${STAFF_ORIGIN}/healthz"
```

The URL may take a few minutes to work while the ECS task becomes healthy and
CloudFront finishes deployment. Check the ECS service events if it stays
unavailable.

## 4. Connect the browser and new email links

Add `-c "adminOrigin=${STAFF_ORIGIN}"` to **all** existing backend CDK flags,
keeping the current `sesSenderEmail=g02.system.des424@gmail.com`. Review the
backend diff and redeploy `Des424G02ScfrmsDev`. This allows the staff origin in
API Gateway and S3 CORS, and gives new work-order/SLA emails a staff ticket
link. Existing emails are unchanged. Then test manager MFA login, technician
login, a direct `/tickets/<full-ticket-id>` URL, and a direct
`/tech/jobs/<full-ticket-id>` URL through the CloudFront site.

## Cleanup after the course

Delete `Des424G02StaffPortal` first; it owns the running ALB and ECS service.
Then delete `Des424G02StaffImage` and its retained ECR repository after the
images are no longer needed. The backend stack is separate.
