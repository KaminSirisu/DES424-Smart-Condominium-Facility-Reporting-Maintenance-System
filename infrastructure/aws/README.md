# G02 development stack

The separate [staff portal container runbook](STAFF-PORTAL.md) covers its ECR,
ECS, ALB and CloudFront stacks. Those resources are not part of the Lambda API
stack described below.

## Extended backend deployment (PR #11)

This branch adds the 15 remaining OpenAPI routes behind
`-c enableExtendedApi=true`: reporter reopen, staff ticket management,
dashboards, manager MFA, and staff accounts. It creates the `AccountEvents`
table and a Secrets Manager MFA encryption key when that flag is enabled.
The revised login also needs `RateLimits` access, and the revised ticket list
needs `CreatedMonthIndex` access; both permissions are included.

Preserve every context flag already used in the deployed stack when running
`infra:diff` and `infra:deploy`. Add `enableExtendedApi=true` when deploying
the merged backend code with this IaC. Review the diff before
deployment. The frontend must also implement the manager MFA screens.

Use `npm run test:smoke:manager-mfa` in an interactive CloudShell session after
deployment, with `STAFF_EMAIL` and `STAFF_PASSWORD` set privately. On first
login it prints the one-time setup key for an authenticator app, then accepts
a hidden six-digit code. It checks the manager profile, dashboard summary,
staff-account list, and manual triage queue without printing the session token.
Keep the setup key out of shared logs and screenshots. The older
`test:smoke:staff-auth` script still tests a technician's direct login.

The five-minute SLA worker is a **separate** `-c enableSlaSweep=true` flag.
Enable it after reviewing existing open tickets: its first run can create
alerts for tickets that already crossed an SLA threshold. The notification
worker now reads active manager accounts for supervisor email. SES sandbox
recipients still need verified email identities.

After the extended routes are deployed, a reporter with a fresh LINE ID token
can exercise reopen on a disposable ticket completed within the last seven
days: `npm run test:smoke:reporter-reopen -- <done-ticket-id>`. The script
checks that the same reporter can still read the ticket and that a retry with
the same idempotency key does not increase the repair cycle twice. It changes
the ticket back to `ASSIGNED`, so do not use a real closed work order.

The CDK stack and its CloudFormation asset-bucket template target only AWS account `528301714999` in `ap-southeast-1`. The foundation was deployed on 2026-11-07 from `infrastructure/scfrms-dev-stack`. Run commands from the repository root.

The development stack now serves health, reporter intake, AI triage, staff
login, staff ticket reads, and technician status updates. A real ticket was
created, triaged, and moved through `IN_PROGRESS` to `DONE` on 2026-11-09. See
the [AWS deployment and smoke-test log](../../docs/architecture/aws-deployment-log.md)
for the observed result and deployment context. The notification worker has
also sent live LINE messages and a PLUMBING work-order email.

This is the current Lambda-based development stack. The original [ECR/ECS/Fargate architecture](../../docs/architecture/deployment-topology.md) is a valid alternative for the backend API, but would replace the API Lambda deployment rather than be added on top of it without a routing decision.

## Deployment sequence based on backend readiness

The Lambda API and stream-worker design is agreed. The ECS staff portal can be
decided separately after the course bonus is clarified. Deploy the development
stack in slices; a successful health check is not a working ticket workflow.

| Slice         | What is ready                                                                                                                                                                           | Status or remaining gate                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation    | Group-owned code asset bucket, eight tables, upload bucket, LINE token secret placeholder, API Gateway, and `GET /v1/health` are deployed and verified.                                 | Complete.                                                                                                                                                        |
| Ticket intake | `POST /uploads` and `POST /tickets` are deployed. A presigned JPEG upload and ticket creation passed a live authenticated smoke test.                                                   | Complete for the backend API. The LIFF app still has a stub submit action.                                                                                       |
| AI triage     | Tickets stream consumer and Claude Sonnet 5 are deployed. A new ticket moved from `RECEIVED` to `ASSIGNED` with category, priority, team and `triagedAt`.                               | Complete for the tested path. Check CloudWatch logs separately to confirm optional Rekognition photo labelling.                                                  |
| Staff auth    | Login and `/me` Lambda routes, a generated signing secret, and a smoke script are deployed behind `enableStaffAuth=true`. A seeded manager account passed the authenticated smoke test. | Manager login and `/me` passed; PLUMBING technician login passed in the status smoke test. Other team accounts remain to be seeded.                              |
| Ticket reads  | `GET /tickets` and `GET /tickets/{ticketId}` are deployed behind `enableStaffTicketReads=true` with specific table and index read permissions.                                          | Manager, technician completed-list, original reporter, and PLUMBING-to-ELECTRICAL cross-team denial smoke tests passed. Second-reporter denial remains.          |
| Staff status  | `PATCH /tickets/{ticketId}/status` and technician proof uploads are deployed behind `enableStaffTicketWrites=true` with scoped IAM permissions.                                         | PLUMBING smoke passed: assigned ticket moved through `IN_PROGRESS` to `DONE` with a JPEG proof. Reporter upload grant regression passed with a fresh LINE token. |
| Photo access  | The route and native `sharp` bundle were deployed behind `enablePhotoAccess=true`. The Lambda now loads the staff secret and checks S3 objects with scoped list access.                 | The original reporter's live photo-access smoke test passed after deploying commit `3d20fa8`.                                                                    |
| Notifications | TicketEvents stream consumer, LINE sender, SES sender, and unit tests exist.                                                                                                            | Deployed and smoke tested for one PLUMBING ticket. The email reached Gmail Spam; Gmail reported SPF PASS, DKIM PASS for `amazonses.com`, and DMARC FAIL.         |
| Staff portal  | Frontend code exists.                                                                                                                                                                   | Finish its API endpoints and authentication; add ECS/ECR/ALB only if the team chooses that bonus path.                                                           |

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
- HTTP API with `GET /v1/health` and coarse stage throttling (10 requests/second, burst 20). `POST /v1/uploads` and `POST /v1/tickets` are added together when the LINE Login channel ID is supplied. Staff routes require their respective context flags.
- Until `enableStaffTicketWrites=true`, the upload Lambda accepts reporter `DEFECT` uploads only; its wrapper returns 403 for `REPAIR_PROOF`. With that flag, the same route also accepts a technician's staff token for `REPAIR_PROOF` and keeps reporter uploads working.
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

To add the staff login and `/me` routes, a generated signing secret is stored
in Secrets Manager and read by both Lambdas at runtime. No secret value is
passed through CDK context or Lambda configuration:

```sh
npm run infra:synth -- -c enableStaffAuth=true
```

To add ticket list and detail routes for both staff and reporters, also pass
`-c enableStaffTicketReads=true`. This requires `enableStaffAuth=true` and the
existing `lineLoginChannelId` context. After deployment, set `STAFF_EMAIL` and
`STAFF_PASSWORD` privately and run
`npm run test:smoke:staff-ticket-read -- <assigned-ticket-id> <team-id>`.
The manager read test needs an assigned ticket for the named team; it does not
need a Teams record or LINE Official Account Manager access.

To add technician status changes and repair-proof uploads, pass
`-c enableStaffTicketWrites=true` together with `enableStaffAuth=true` and
`lineLoginChannelId`. This adds `PATCH /v1/tickets/{ticketId}/status`, enables
staff use of the existing `POST /v1/uploads`, and permits PATCH in API CORS.
Before deploying, preserve the already deployed `enableTriage=true`,
`bedrockModelId`, and `enableStaffTicketReads=true` context values in the diff
and deploy commands. The new route needs a seeded technician account for the
ticket's team; the manager account cannot change status. For a single shared
PLUMBING login, set `ACCOUNTS_TABLE_NAME` in CloudShell and run:

```sh
export ACCOUNTS_TABLE_NAME=des424-g02-scfrms-dev-Accounts
npm run seed:technician -w @scfrms/backend -- --email <plumber-email> --team PLUMBING
```

Copy the generated password privately. Running the seed again skips an
existing account without changing its password. The email is a login name;
this test does not send mail to it. With a disposable assigned PLUMBING ticket
and a JPEG proof photo, set that technician's `STAFF_EMAIL` and `STAFF_PASSWORD`
privately and run:

```sh
npm run test:smoke:staff-ticket-status -- <disposable-assigned-ticket-id> <jpeg-path>
```

This test changes that ticket from `ASSIGNED` through `IN_PROGRESS` to `DONE`.
It checks the proof upload and persisted ticket view. Do not use a real ticket
that must remain open. After that ticket is `DONE`, the same technician can
check the completed index and team list restrictions without changing ticket
data:

```sh
npm run test:smoke:staff-completed-list -- <completed-ticket-id>
```

This checks the technician's completed list, absence from the open queue,
cross-team list rejection, and invalid mixed-status rejection. It does not
test access to another team's ticket detail; that needs a known ticket from
another team. After enabling the shared upload handler, set a fresh
`LINE_ID_TOKEN` privately and run `npm run test:smoke:reporter-upload`. That
check requests an authenticated reporter upload grant without writing another
ticket or printing the presigned URL.

For the completed reporter ticket, use a fresh `LINE_ID_TOKEN` from the same
LINE user who created it and run:

```sh
npm run test:smoke:reporter-ticket-read -- <completed-ticket-id>
```

This read-only check covers the reporter's completed list and detail,
rejects a staff-only team filter, and checks that no private fields appear in
the responses. It does not prove that a different reporter is denied; that
requires a second LINE account.

For subsequent changes to `GET /v1/tickets/{ticketId}/photos/{photoId}/access`,
deploy from Linux x64 CloudShell: the `sharp` native module is installed for
the build machine's platform. Do not deploy this slice from a macOS-generated
CDK asset. Preserve every existing CDK context value, including
`-c enablePhotoAccess=true`, on both `infra:diff` and `infra:deploy`. Before
deploying, synthesize with those same values and check the resulting package:

```sh
npm run infra:synth -- -c lineLoginChannelId=2011904216 \
  -c enableTriage=true -c bedrockModelId=anthropic.claude-sonnet-5 \
  -c enableStaffAuth=true -c enableStaffTicketReads=true \
  -c enableStaffTicketWrites=true -c enablePhotoAccess=true > /dev/null
npm run infra:check:photo-asset
```

The check loads `sharp` from the actual synthesized photo Lambda asset and
creates a JPEG with its Linux x64 binary. If it fails or CloudShell has too
little disk space, stop before deployment. In a new stack, enabling this slice
adds one Lambda, its log group and scoped IAM permissions, one API integration,
and one route. After deployment, use a fresh `LINE_ID_TOKEN` from the reporter
who created the known ticket and run:

```sh
npm run test:smoke:photo-access -- <completed-ticket-id>
```

The smoke test requests a defect-photo grant, fetches the signed URL without
printing it, and checks the returned image's JPEG format, size, dimensions,
and absent EXIF metadata. The first request may write a thumbnail copy to the
private S3 bucket; the original upload stays untouched.

After deployment, seed the first manager account privately with the backend's
`seed:accounts` script and test login and `/me` using
`npm run test:smoke:staff-auth` with `STAFF_EMAIL` and `STAFF_PASSWORD` set in
the shell. The script does not print either the password or the returned token.
If a generated password is exposed, disable that account and increment its
`tokenVersion`, then run the backend's `rotate:staff-password` script with
`--email`. It requires a disabled account, generates a new password, clears
any lock, reactivates the account, and invalidates older sessions. Keep its
one-time password output private.

To include notification delivery, first replace the generated LINE secret value, verify an SES sender and the test recipients in Singapore, and add team records with their email addresses. Then provide:

```sh
npm run infra:synth -- -c enableNotifications=true -c sesSenderEmail=verified@example.com -c liffUrl=https://liff.line.me/YOUR_LIFF_ID
```

Pass the same context values to `infra:diff` and, after review, `infra:deploy`. `-c adminOrigin=https://...` adds the staff frontend origin to API and S3 CORS. Never put the LINE token in a CDK context value, CLI argument, `.env` file, or Git.

## Remaining integration decisions

- The backend's `POST /tickets` handler expects API Gateway **payload v2**, so this stack uses HTTP API. HTTP API stage throttling is available, but an AWS WAF web ACL cannot be directly associated with an HTTP API stage. The proposed **per-IP WAF limit** is therefore not implemented here. The DynamoDB per-LINE-user limit remains in the backend. Decide whether to use CloudFront in front of this API or adapt the backend to REST API before claiming the per-IP requirement is met.
- The LIFF app still submits a stub report; it must call `POST /uploads`, PUT the image to the returned URL, then call `POST /tickets` with the upload ID. The upload route needs the LINE Login channel ID, and the full flow needs a real LINE ID token for testing.
- Staff login and `/me` are deployed behind `enableStaffAuth=true` and passed an authenticated manager smoke test. Ticket reads are deployed behind `enableStaffTicketReads=true` and passed manager, technician completed-list, and original reporter read smoke tests. Staff status changes and proof uploads are deployed behind `enableStaffTicketWrites=true`; a PLUMBING technician completed an assigned test ticket with a JPEG proof. The reporter upload grant regression and photo access passed; cross-team ticket detail and second-reporter denial still need live checks. The staff signing secret is generated in Secrets Manager when staff auth is enabled.
- The standalone Sonnet 5 call succeeded after removing its deprecated `temperature` parameter, and the live intake-to-Bedrock-to-DynamoDB triage path passed a smoke test. Optional Rekognition photo labelling has not been confirmed from logs; the triage Lambda has a 60-second timeout for both service calls. SES is currently in the Singapore sandbox; the verified sender and PLUMBING recipient delivered a work-order email to Gmail Spam.
- `RateLimits` is incremented before the ticket transaction. A failed transaction can consume a quota slot. Coordinate this with the backend developer before production use.
- This stack deliberately creates no staff passwords or email addresses. One manager account was seeded manually; team records and technician accounts remain to be seeded.
