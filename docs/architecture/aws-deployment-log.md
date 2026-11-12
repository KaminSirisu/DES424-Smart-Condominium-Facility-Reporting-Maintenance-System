# G02 AWS deployment and smoke-test log

Last verified: **2026-11-12 (Asia/Bangkok)**. Environment: AWS account
`528301714999`, region `ap-southeast-1`, CloudFormation stack
`Des424G02ScfrmsDev`. This records observed development-environment behavior;
it is not a production readiness claim.

## Deployed slices

| Slice               | Deployed resources and result                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation          | Group-owned CDK asset bucket, eight on-demand DynamoDB tables, private S3 upload bucket, initially placeholder LINE Messaging API secret (later replaced), API Gateway HTTP API, and health Lambda. `GET /v1/health` returned HTTP 200 with `{"status":"ok"}`. |
| Reporter intake     | `POST /v1/uploads` and `POST /v1/tickets` Lambda routes with LINE Login ID-token verification. A real JPEG was uploaded with a presigned S3 URL, then a ticket was created in DynamoDB with status `RECEIVED`.                                                                     |
| AI triage           | Tickets DynamoDB Stream event source, triage Lambda, CloudWatch log group, and SQS failure queue. A newly inserted ticket was classified and updated to `ASSIGNED`. The worker uses `anthropic.claude-sonnet-5` in Singapore.                                                      |
| Staff auth          | `POST /v1/auth/staff/login` and `GET /v1/auth/staff/me` Lambda routes, plus a generated signing secret in Secrets Manager. A seeded manager account passed the authenticated login and `/me` smoke test. Unauthenticated route checks returned the expected 400 and 401 responses. |
| Ticket reads        | `GET /v1/tickets` and `GET /v1/tickets/{ticketId}` Lambda routes were deployed with specific DynamoDB read permissions. Both returned 401 without a token. A manager session listed the PLUMBING team's tickets and read the known ticket without exposing private fields.         |
| Staff status        | `PATCH /v1/tickets/{ticketId}/status` and technician `REPAIR_PROOF` uploads were deployed. A PLUMBING technician moved the test ticket from `ASSIGNED` to `IN_PROGRESS` to `DONE`, uploaded a JPEG proof, and read back the persisted result.                                      |
| Staff history index | `TeamDoneIndex` was added to the Tickets table for completed-ticket queries. The PLUMBING technician's completed-list smoke test found the DONE ticket through the API.                                                                                                            |
| Photo access        | `GET /v1/tickets/{ticketId}/photos/{photoId}/access` and a Lambda bundle containing native `sharp` were deployed. After correcting secret bootstrap and S3 lookup, the original reporter's live photo-access smoke test passed.                                                    |
| Notifications       | The `TicketEvents` stream notification Lambda sent LINE messages to the reporter and an SES work order to the PLUMBING team after a fresh ticket was triaged. The team email reached Gmail Spam; delivery to the mailbox was confirmed, but Inbox placement was not.                   |

API base URL: `https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1`.
The current deployment used the `infrastructure/api-intake-readiness`
branch and these CDK context values:

```sh
npm run infra:deploy -- --require-approval never \
  -c lineLoginChannelId=2011904216 \
  -c enableTriage=true \
  -c bedrockModelId=anthropic.claude-sonnet-5 \
  -c enableStaffAuth=true \
  -c enableStaffTicketReads=true \
  -c enableStaffTicketWrites=true \
  -c enablePhotoAccess=true \
  -c enableNotifications=true \
  -c sesSenderEmail=manager.des424@gmail.com \
  -c liffUrl=https://liff.line.me/2011904216-fXRa82NM
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

This proves manager read access to that assigned ticket. Access to another
team's ticket detail remains untested in the live environment.

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
recorded. Separate unauthenticated `DEFECT` and `REPAIR_PROOF` upload-intent
requests both returned HTTP 401 after the update. A fresh LINE ID token then
passed the reporter upload regression check:

```text
Reporter upload grant passed with a fresh LINE ID token.
```

This checks the reporter `DEFECT` upload grant after the shared upload Lambda
was updated for staff proof uploads; it does not create another ticket.

On 2026-11-10, after rotating the PLUMBING technician password privately,
the completed-list smoke test returned:

```text
Completed list and team scope passed for tkt_f89feaa654f55c9bbf05ea10a6 (PLUMBING).
```

This exercised `TeamDoneIndex` through the live API, checked that the DONE
ticket was absent from the open queue, and confirmed HTTP 403 for a
cross-team list request and HTTP 422 for mixed DONE/ASSIGNED filtering. It
did not test access to a ticket belonging to another team.

The original reporter then used a fresh LINE Login ID token and ran the
reporter ticket read smoke test. It returned:

```text
Reporter ticket list and detail passed for tkt_f89feaa654f55c9bbf05ea10a6.
```

The test checked that the completed ticket appeared in that reporter's list
and detail response, that a staff-only team filter returned HTTP 403, and
that neither response exposed private fields. It did not test whether a
different LINE user is denied access; that needs a second LINE account.

The first attempt with a reused LINE ID token returned HTTP 401. Direct LINE
verification showed that token had expired. A fresh login and new ID token
made the same smoke test pass. No token value is stored in this log or in Git.

On 2026-11-10, the photo-access smoke test against the deployed route returned
HTTP 500. CloudWatch identified `STAFF_JWT_SECRET environment variable is not
set` in `getTicketPhotoAccess`. The Lambda had been deployed from the handler
directly, skipping the Secrets Manager bootstrap used by the other mixed
staff/reporter routes. The correction uses a bootstrap entry point. The photo
helper also now checks for a missing thumbnail through a prefix-scoped S3 list
operation, which avoids a 403 from `HeadObject` on a missing key without broad
bucket-list permission. After deploying commit `3d20fa8`, the first retry
returned HTTP 401 because the reporter's LINE ID token had expired. With a
fresh ID token from the original reporter, the smoke test returned:

```text
Reporter photo access passed for tkt_f89feaa654f55c9bbf05ea10a6.
```

The script checked ticket detail, unauthenticated rejection, a signed defect
photo URL, the fetched JPEG's size, dimensions and absent EXIF, and missing
photo handling. The token and signed URL were not recorded.

On 2026-11-10, a fresh ticket `tkt_f0be93a07f6e43e8286e06189d` produced
`CREATED` and `TRIAGED` events. The notification Lambda log recorded successful
`LINE_REPORTER` sends for both events and an `EMAIL_TEAM` send for the triage
event. The reporter observed the LINE messages. The PLUMBING team later found
the work-order email in Gmail Spam. A direct SES delivery test to the same
mailbox also arrived in Spam, so the missing Inbox message was not a missing
team record or failed notification trigger. The sender
`manager.des424@gmail.com` and recipient `tech.plumber.des424@gmail.com` were
verified SES identities in Singapore. SES was still in sandbox mode. The
sender email identity reported DKIM `NOT_STARTED`; the Gmail message's SPF,
DKIM and DMARC results have not yet been checked. No token or email password
is recorded here.

On 2026-11-12, after the PLUMBING technician's password was rotated privately,
the live status/proof smoke test was rerun against that ticket:

```text
Staff status and proof upload passed for tkt_f0be93a07f6e43e8286e06189d: ASSIGNED -> IN_PROGRESS -> DONE.
```

The user observed LINE status messages during this test. It confirms the
deployed status API, proof upload and reporter notifications for this ticket.
The first test ticket had already passed the same transition earlier; this is
the first recorded run after notifications were enabled. The technician
password, staff token and LINE channel access token were not recorded.

## Next deployment gates

- A cross-team ticket-detail check needs a known ticket assigned to another
  team. A different-reporter denial check needs a second LINE account. Deploy
  and test the remaining staff write routes and reporter reopen.
- Seed Teams records and the other shared team accounts when their names and
  notification email addresses are agreed.
- Inspect the received work-order email's Gmail "Show original" authentication
  results and spam explanation before changing the SES sender setup. The
  current verified Gmail-address sender through SES reached the mailbox but
  was filtered to Spam. No domain identity or DKIM configuration has been
  deployed for a project-owned sender domain.
- The backend PR for the remaining API routes, manager MFA and SLA sweep is
  not yet deployed. It requires an `AccountEvents` table, an MFA encryption
  secret, additional routes and IAM, and a scheduled sweep Lambda before live
  tests. Manager login smoke tests must be updated for the MFA flow.
- The LIFF frontend still needs to call the live upload and ticket endpoints
  instead of its stub submit action.
- ECS/ECR/ALB for the staff portal remains a proposed course-bonus option,
  pending professor feedback. No container service is deployed in this stack.
