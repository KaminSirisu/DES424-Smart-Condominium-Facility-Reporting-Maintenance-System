# G02 AWS deployment and smoke-test log

Last verified: **2026-11-09 (Asia/Bangkok)**. Environment: AWS account
`528301714999`, region `ap-southeast-1`, CloudFormation stack
`Des424G02ScfrmsDev`. This records observed development-environment behavior;
it is not a production readiness claim.

## Deployed slices

| Slice               | Deployed resources and result                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation          | Group-owned CDK asset bucket, eight on-demand DynamoDB tables, private S3 upload bucket, placeholder LINE Messaging API secret, API Gateway HTTP API, and health Lambda. `GET /v1/health` returned HTTP 200 with `{"status":"ok"}`.                                                |
| Reporter intake     | `POST /v1/uploads` and `POST /v1/tickets` Lambda routes with LINE Login ID-token verification. A real JPEG was uploaded with a presigned S3 URL, then a ticket was created in DynamoDB with status `RECEIVED`.                                                                     |
| AI triage           | Tickets DynamoDB Stream event source, triage Lambda, CloudWatch log group, and SQS failure queue. A newly inserted ticket was classified and updated to `ASSIGNED`. The worker uses `anthropic.claude-sonnet-5` in Singapore.                                                      |
| Staff auth          | `POST /v1/auth/staff/login` and `GET /v1/auth/staff/me` Lambda routes, plus a generated signing secret in Secrets Manager. A seeded manager account passed the authenticated login and `/me` smoke test. Unauthenticated route checks returned the expected 400 and 401 responses. |
| Ticket reads        | `GET /v1/tickets` and `GET /v1/tickets/{ticketId}` Lambda routes were deployed with specific DynamoDB read permissions. Both returned 401 without a token. A manager session listed the PLUMBING team's tickets and read the known ticket without exposing private fields.         |
| Staff status        | `PATCH /v1/tickets/{ticketId}/status` and technician `REPAIR_PROOF` uploads were deployed. A PLUMBING technician moved the test ticket from `ASSIGNED` to `IN_PROGRESS` to `DONE`, uploaded a JPEG proof, and read back the persisted result.                                      |
| Staff history index | `TeamDoneIndex` was added to the Tickets table for completed-ticket queries. The index has not yet been exercised by a live staff API route.                                                                                                                                       |

API base URL: `https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1`.
The staff-status deployment used the `infrastructure/api-intake-readiness`
branch and these CDK context values:

```sh
npm run infra:deploy -- --require-approval never \
  -c lineLoginChannelId=2011904216 \
  -c enableTriage=true \
  -c bedrockModelId=anthropic.claude-sonnet-5 \
  -c enableStaffAuth=true \
  -c enableStaffTicketReads=true \
  -c enableStaffTicketWrites=true
```

Pass the same context values on subsequent `infra:diff` and `infra:deploy`
commands. Omitting them would synthesize a stack without the corresponding
optional routes or worker.

## Live test evidence

The authenticated smoke script (`tests/smoke/intake.mjs`) requested an upload
grant, uploaded a JPEG, and created a new report. After setting `LINE_ID_TOKEN`
privately in CloudShell, the test used:

```sh
node tests/smoke/intake.mjs /path/to/photo.jpeg \
  'Fitness Facility' \
  'The restroom faucet is leaking continuously.'
```

Its output was:

```text
Created ticket tkt_f89feaa654f55c9bbf05ea10a6 with status RECEIVED.
```

A subsequent DynamoDB `GetItem` on
`des424-g02-scfrms-dev-Tickets`, keyed by that ticket ID, returned:

```json
{
  "status": "ASSIGNED",
  "category": "PLUMBING",
  "priority": "LOW",
  "teamId": "PLUMBING",
  "triagedAt": "2026-11-08T20:47:00.323Z"
}
```

The `triagedAt` timestamp is **2026-11-09 03:47:00 Asia/Bangkok**. In this
workflow, `ASSIGNED` plus `triagedAt` represents completed triage; there is no
separate `TRIAGED` ticket status. The test confirms the live intake, stream
trigger, classification, and ticket update. The classifier can continue from
text if Rekognition photo labelling fails, so this result alone does not prove
that photo labelling succeeded. The earlier ticket created before the worker
was enabled remains `RECEIVED` because the stream mapping starts at `LATEST`.

The staff-route checks on 2026-11-09 returned HTTP 200 from `/v1/health`, HTTP
401 from `/v1/auth/staff/me` without a bearer token, and HTTP 400 from
`POST /v1/auth/staff/login` with `{}`. After seeding a manager account and
rotating its initial credential, `npm run test:smoke:staff-auth` returned:

```text
Staff login and /me passed for role MANAGER.
```

The smoke script checked the authenticated login response and retrieved the
same safe manager profile from `/me`. The password, its hash, and the staff
token are not stored in this log or in Git.

After the ticket-read deployment, both GET routes returned HTTP 401 without a
token. The manager smoke script then listed team `PLUMBING` and fetched ticket
`tkt_f89feaa654f55c9bbf05ea10a6` with the staff token. It checked the
responses for private fields and returned:

```text
Staff ticket list and detail passed for tkt_f89feaa654f55c9bbf05ea10a6.
```

This proves manager read access to that assigned ticket. Reporter reads,
technician team restrictions, and completed-ticket history remain untested in
the live environment.

After the staff-status deployment, `GET /v1/health` returned HTTP 200 and an
unauthenticated `PATCH /v1/tickets/{ticketId}/status` returned HTTP 401. A
single PLUMBING technician account was seeded privately. With its credentials
set only in CloudShell, the status smoke script used the earlier test ticket
and a JPEG proof photo. It returned:

```text
Staff status and proof upload passed for tkt_f89feaa654f55c9bbf05ea10a6: ASSIGNED -> IN_PROGRESS -> DONE.
```

The script checked technician login, an unauthenticated 401, an idempotent
`IN_PROGRESS` retry, a presigned S3 proof upload, the `DONE` response, and a
fresh GET showing the persisted status and proof photo without private fields.
The test ticket is now `DONE`. The technician password and staff token were not
recorded. A fresh reporter intake test has not yet been run against the updated
shared upload Lambda. Separate unauthenticated `DEFECT` and `REPAIR_PROOF`
upload-intent requests both returned HTTP 401 after the update.

The first attempt with a reused LINE ID token returned HTTP 401. Direct LINE
verification showed that token had expired. A fresh login and new ID token
made the same smoke test pass. No token value is stored in this log or in Git.

## Next deployment gates

- Run `npm run test:smoke:reporter-upload` with a fresh LINE ID token to check
  the shared upload Lambda after staff proof uploads were enabled. Verify team-scoped reads and
  the completed-ticket list; deploy and test the remaining staff write routes
  and photo access. The completed-ticket index has not yet been exercised live.
- Seed Teams records and the other shared team accounts when their names and
  notification email addresses are agreed.
- The notification worker is not enabled. Replace the placeholder LINE
  Messaging API token, verify the SES sender and permitted recipients, seed
  team work-order email addresses, then test a newly inserted audit event of
  kind `TRIAGED`.
- The LIFF frontend still needs to call the live upload and ticket endpoints
  instead of its stub submit action.
- ECS/ECR/ALB for the staff portal remains a proposed course-bonus option,
  pending professor feedback. No container service is deployed in this stack.
