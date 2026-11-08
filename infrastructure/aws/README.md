# G02 development stack

The CDK stack and its CloudFormation asset-bucket template target only AWS account `528301714999` in `ap-southeast-1`. The foundation was deployed on 2026-11-07 from `infrastructure/scfrms-dev-stack`. Run commands from the repository root.

Live health check: `GET https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1/health` returned HTTP 200 and `{"status":"ok"}`. This confirms API Gateway → Lambda only; the ticket route and stream workers are still disabled.

This is the current Lambda-based development stack. The original [ECR/ECS/Fargate architecture](../../docs/architecture/deployment-topology.md) is a valid alternative for the backend API, but would replace the API Lambda deployment rather than be added on top of it without a routing decision.

## Deployment sequence based on backend readiness

The Lambda API and stream-worker design is agreed. The ECS staff portal can be
decided separately after the course bonus is clarified. Deploy the development
stack in slices; a successful health check is not a working ticket workflow.

| Slice         | What is ready                                                                                                                                           | Gate before enabling it                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation    | Group-owned code asset bucket, eight tables, upload bucket, LINE token secret placeholder, API Gateway, and `GET /v1/health` synthesize and pass tests. | Confirm the G02 AWS identity, validate the asset template, and review `cdk diff`, then deploy.                                                                      |
| Ticket intake | `POST /uploads` and `POST /tickets` handlers and unit tests exist on the SCFRMS-44 backend branch; this integration branch wires both routes.           | Supply the LINE Login channel ID, deploy this branch, then run a real presigned-upload and ticket-creation smoke test. The LIFF app still has a stub submit action. |
| AI triage     | Tickets stream consumer, classifier, and unit tests exist.                                                                                              | Choose a Bedrock model available to this account in Singapore; exercise a real invocation and confirm the model response works with the classifier.                 |
| Notifications | TicketEvents stream consumer, LINE sender, SES sender, and unit tests exist.                                                                            | Replace the placeholder LINE secret, verify the SES sender and sandbox recipients or obtain production access, and seed Teams records with email addresses.         |
| Staff portal  | Frontend code exists.                                                                                                                                   | Finish its API endpoints and authentication; add ECS/ECR/ALB only if the team chooses that bonus path.                                                              |

The repository currently has no AWS CLI or local AWS credential profile in the
development environment. A console username and password alone do not
authenticate local CDK commands. Use an approved CLI credential method or AWS
CloudShell, and check the account with `aws sts get-caller-identity` before
running `cdk diff` or deploy. CloudShell must have access to the
committed IaC branch. Never copy console passwords or LINE secrets into this
repository.

The shared account has no default `/cdk-bootstrap/hnb659fds/version` parameter.
This app uses `CliCredentialsStackSynthesizer` and a **G02-owned code asset S3
bucket** instead of the standard CDK bootstrap roles. The small
`asset-staging.json` CloudFormation template creates that bucket first. Submit
it directly with the AWS CLI: CDK would try to upload its own stack template
into the bucket before the bucket exists. The `Des424G02ScfrmsDev` stack then
uploads Lambda bundles there. CDK uses the signed-in G02 user's existing
permissions for CloudFormation and asset publishing. It does not create or
assume CDK deploy, lookup, or publishing roles. The dev stack still creates a
normal Lambda execution role; if G02 lacks permission for that, deployment will
fail and an account administrator must grant the needed scope. The asset bucket
is retained if its stack is deleted, so remove it deliberately during course
cleanup.

## Resources

- G02-owned private S3 code asset bucket for CDK Lambda bundles. No ECR repository is created.
- Eight on-demand DynamoDB tables: `Tickets`, `TicketReporters`, `TicketPhotos`, `TicketEvents`, `Accounts`, `Teams`, `Notifications`, `RateLimits`. Table names start `des424-g02-scfrms-dev-`. `Tickets` and `TicketEvents` have streams; `RateLimits` has TTL on `expiresAt`.
- Private S3 upload bucket with public access blocked and CORS limited to the existing LIFF Amplify origin (plus an optional admin origin).
- HTTP API with `GET /v1/health` and coarse stage throttling (10 requests/second, burst 20). `POST /v1/uploads` and `POST /v1/tickets` are added together when the LINE Login channel ID is supplied. Other OpenAPI routes are not deployed in this slice.
- The first upload Lambda accepts reporter `DEFECT` uploads only. Its small wrapper returns 403 for `REPAIR_PROOF`, because staff login and a shared JWT signing secret are not deployed yet. The staff upload path must be enabled with those routes later.
- Optional stream workers for triage and notifications. Each has partial batch failure handling, three retries, and an SQS failure queue.
- New stream mappings start at `LATEST`: enabling a worker later processes new events only. Existing `RECEIVED` tickets need an explicit backfill or manual triage plan.
- Secrets Manager secret for the LINE Messaging API token. The generated initial value is a **placeholder**; update it in Secrets Manager before enabling notifications. The worker fetches it at runtime rather than storing it in Lambda environment variables.

The tables and buckets have `RETAIN` removal policies. Deleting the stacks does not delete them. This protects ticket data, but retained dev resources can keep costing money until intentionally cleaned up. This deployment creates no VPC, NAT gateway, ECS, ECR, RDS, or always-on compute.

## Prepare and review

```sh
npm ci
npm run infra:typecheck
npm run infra:synth
npm run infra:diff -- --method template
aws cloudformation validate-template --template-body file://infrastructure/aws/asset-staging.json --region ap-southeast-1
```

`infra:synth` needs no AWS changes. Template-mode `infra:diff` reads the account without creating a CloudFormation change set. Inspect the diff and expected costs before deployment. The dev stack creates only the health endpoint by default, so the data/API foundation can be prepared while integration values are still missing. Do **not** run `cdk bootstrap` for this app.

For a fresh environment, create the asset bucket before deploying the CDK stack. Both steps are already complete in G02 Singapore; subsequent `infra:deploy` runs update the dev stack:

```sh
aws cloudformation deploy --template-file infrastructure/aws/asset-staging.json --stack-name Des424G02AssetStaging --region ap-southeast-1
npm run infra:deploy
```

To include ticket intake, provide the **LINE Login channel ID** (the numeric channel ID, not the LIFF ID):

```sh
npm run infra:synth -- -c lineLoginChannelId=YOUR_CHANNEL_ID
```

To include AI triage, also choose and test a Bedrock model available in Singapore:

```sh
npm run infra:synth -- -c enableTriage=true -c bedrockModelId=YOUR_MODEL_ID
```

To include notification delivery, first replace the generated LINE secret value, verify an SES sender and the test recipients in Singapore, and add team records with their email addresses. Then provide:

```sh
npm run infra:synth -- -c enableNotifications=true -c sesSenderEmail=verified@example.com -c liffUrl=https://liff.line.me/YOUR_LIFF_ID
```

Pass the same context values to `infra:diff` and, after review, `infra:deploy`. `-c adminOrigin=https://...` adds the staff frontend origin to API and S3 CORS. Never put the LINE token in a CDK context value, CLI argument, `.env` file, or Git.

## Remaining integration decisions

- The backend's `POST /tickets` handler expects API Gateway **payload v2**, so this stack uses HTTP API. HTTP API stage throttling is available, but an AWS WAF web ACL cannot be directly associated with an HTTP API stage. The proposed **per-IP WAF limit** is therefore not implemented here. The DynamoDB per-LINE-user limit remains in the backend. Decide whether to use CloudFront in front of this API or adapt the backend to REST API before claiming the per-IP requirement is met.
- The LIFF app still submits a stub report; it must call `POST /uploads`, PUT the image to the returned URL, then call `POST /tickets` with the upload ID. The upload route needs the LINE Login channel ID, and the full flow needs a real LINE ID token for testing.
- Staff authentication and ticket management handlers exist on the SCFRMS-44 backend branch but are not wired in this stack. Add a protected JWT signing secret and deploy staff login with the staff upload path in a later slice.
- AI triage has not been tried against the chosen Bedrock model. SES is currently in the Singapore sandbox with zero identities; outgoing work orders cannot be tested until verified.
- `RateLimits` is incremented before the ticket transaction. A failed transaction can consume a quota slot. Coordinate this with the backend developer before production use.
- The staff account and team records must be seeded after deployment; this stack deliberately creates no passwords or email addresses.
