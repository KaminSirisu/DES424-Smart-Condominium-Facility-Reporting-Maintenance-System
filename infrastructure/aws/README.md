# G02 development stack

This CDK stack targets only AWS account `528301714999` in `ap-southeast-1`. It is **defined but not deployed**. Run commands from the repository root.

This is the current Lambda-based development stack. The original [ECR/ECS/Fargate architecture](../../docs/architecture/deployment-topology.md) is a valid alternative for the backend API, but would replace the API Lambda deployment rather than be added on top of it without a routing decision.

## Deployment sequence based on backend readiness

The Lambda API and stream-worker design is agreed. The ECS staff portal can be
decided separately after the course bonus is clarified. Deploy the development
stack in slices; a successful health check is not a working ticket workflow.

| Slice         | What is ready                                                                                                                | Gate before enabling it                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation    | Eight tables, upload bucket, LINE token secret placeholder, API Gateway, and `GET /v1/health` synthesize and pass CDK tests. | Confirm the AWS identity is G02 account `528301714999` in `ap-southeast-1`, check CDK bootstrap and `cdk diff`, then deploy.                                |
| Ticket intake | `POST /tickets` Lambda handler and unit tests exist.                                                                         | Supply the LINE Login channel ID and implement `POST /uploads`; ticket creation rejects a photo upload that is not already present in S3.                   |
| AI triage     | Tickets stream consumer, classifier, and unit tests exist.                                                                   | Choose a Bedrock model available to this account in Singapore; exercise a real invocation and confirm the model response works with the classifier.         |
| Notifications | TicketEvents stream consumer, LINE sender, SES sender, and unit tests exist.                                                 | Replace the placeholder LINE secret, verify the SES sender and sandbox recipients or obtain production access, and seed Teams records with email addresses. |
| Staff portal  | Frontend code exists.                                                                                                        | Finish its API endpoints and authentication; add ECS/ECR/ALB only if the team chooses that bonus path.                                                      |

The repository currently has no AWS CLI or local AWS credential profile in the
development environment. A console username and password alone do not
authenticate local CDK commands. Use an approved CLI credential method or AWS
CloudShell, and check the account with `aws sts get-caller-identity` before
running `cdk diff`, bootstrap, or deploy. CloudShell must have access to the
committed IaC branch. Never copy console passwords or LINE secrets into this
repository.

## Resources

- Eight on-demand DynamoDB tables: `Tickets`, `TicketReporters`, `TicketPhotos`, `TicketEvents`, `Accounts`, `Teams`, `Notifications`, `RateLimits`. Table names start `des424-g02-scfrms-dev-`. `Tickets` and `TicketEvents` have streams; `RateLimits` has TTL on `expiresAt`.
- Private S3 upload bucket with public access blocked and CORS limited to the existing LIFF Amplify origin (plus an optional admin origin).
- HTTP API with `GET /v1/health` and coarse stage throttling (10 requests/second, burst 20). `POST /v1/tickets` is added when the LINE Login channel ID is supplied. Other OpenAPI routes are not deployed because their handlers are not implemented yet.
- Optional stream workers for triage and notifications. Each has partial batch failure handling, three retries, and an SQS failure queue.
- New stream mappings start at `LATEST`: enabling a worker later processes new events only. Existing `RECEIVED` tickets need an explicit backfill or manual triage plan.
- Secrets Manager secret for the LINE Messaging API token. The generated initial value is a **placeholder**; update it in Secrets Manager before enabling notifications. The worker fetches it at runtime rather than storing it in Lambda environment variables.

The tables and bucket have `RETAIN` removal policies. Deleting the stack does not delete them. This protects ticket data, but retained dev resources can keep costing money until intentionally cleaned up. This development stack creates no VPC, NAT gateway, ECS, ECR, RDS, or always-on compute.

## Prepare and review

```sh
npm ci
npm run infra:typecheck
npm run infra:synth
npm run infra:diff
```

`infra:synth` needs no AWS changes. `infra:diff` reads the account and may need CDK bootstrap access. Inspect the generated template and cost before deployment. The stack creates only the health endpoint by default, so it is safe to prepare the data/API foundation while integration values are still missing.

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
- The current backend has no `POST /uploads` handler, staff authentication, or other ticket routes. The LIFF app cannot complete a real report through this stack yet.
- AI triage has not been tried against the chosen Bedrock model. SES is currently in the Singapore sandbox with zero identities; outgoing work orders cannot be tested until verified.
- `RateLimits` is incremented before the ticket transaction. A failed transaction can consume a quota slot. Coordinate this with the backend developer before production use.
- The staff account and team records must be seeded after deployment; this stack deliberately creates no passwords or email addresses.
