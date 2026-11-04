# Backend implementation notes

What the backend code stores and reads today (SCFRMS-40, 41, 46, the SLA-02 safety override and the SR-31 rate limit). The table keys follow the proposal in [DynamoDB access patterns](dynamodb-access-patterns.md) (SCFRMS-28). This file only records what the code does and where it adds to that proposal; additions are marked as proposals for team review. Nothing here has been run against real AWS yet; the tests use mocks.

## Tables used

Each table name comes from an environment variable (`backend/src/shared/tables.ts`), so the infrastructure decides the real names.

| Table             | Environment variable          | Keys and indexes                                                                                                   | Written by                                 |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `Tickets`         | `TICKETS_TABLE_NAME`          | PK `ticketId`; `TeamOpenIndex` (`teamStatusKey`, `createdKey`); `CreatedMonthIndex` (`createdMonth`, `createdKey`) | `POST /tickets`, AI triage                 |
| `TicketReporters` | `TICKET_REPORTERS_TABLE_NAME` | PK `ticketId`, SK `reporterLineUserId`; `ReporterTicketsIndex` (`reporterLineUserId`, `associatedKey`)             | `POST /tickets`                            |
| `TicketPhotos`    | `TICKET_PHOTOS_TABLE_NAME`    | PK `ticketId`, SK `photoId`                                                                                        | `POST /tickets`                            |
| `TicketEvents`    | `TICKET_EVENTS_TABLE_NAME`    | PK `ticketId`, SK `eventKey` = `<occurredAt>#<eventId>`                                                            | `POST /tickets`, AI triage                 |
| `Notifications`   | `NOTIFICATIONS_TABLE_NAME`    | PK `ticketId`, SK `notificationKey` = `<eventId>#<channel>`                                                        | notification worker (proposal)             |
| `RateLimits`      | `RATE_LIMITS_TABLE_NAME`      | PK `limitKey`, SK `windowStart` (number); TTL attribute `expiresAt`; no stream                                     | `POST /tickets` (proposal)                 |
| `Teams`           | `TEAMS_TABLE_NAME`            | PK `teamId`; `email` is a proposed field                                                                           | read by the notification worker (proposal) |

The `Accounts` table of SCFRMS-28 is not used by this code yet.

## Tickets

**Ticket id.** `tkt_` plus the first 26 hex characters of `sha256(lineUserId + "\n" + Idempotency-Key)`. A retry with the same key reaches the same item; two reporters using the same key never collide.

**Create (`POST /tickets`).** One transaction writes the ticket (conditional on `attribute_not_exists(ticketId)`, so a duplicate id cancels everything), the reporter link, one `TicketPhotos` item per defect photo and a `TICKET_CREATED` event. The ticket starts as `RECEIVED`, `repairCycle` 1, `version` 1. The same payload replayed gets the original `201`; a different payload with the same key gets `409`.

**Read.** `getTicket` reads the ticket and queries its photos, both strongly consistent, and returns one record with an embedded photo list. Callers never see storage attributes.

**Fields stored on the ticket.** The fields of the `Ticket` schema in `openapi.yaml`, plus:

- storage attributes: `ticketId` (the key), `createdMonth` (`YYYY-MM`), `createdKey` (`<createdAt>#<ticketId>`), and at triage `teamStatusKey` (`TEAM#<teamId>#STATUS#ASSIGNED`, which puts the ticket in `TeamOpenIndex`);
- internal fields, never returned to callers: `reporterLineUserId` (the original reporter), `version` (optimistic-locking counter), `safetyHazard` (SLA-02, below), and on each photo `s3ObjectKey`;
- set at triage: `slaPolicyVersion`, `triagedAt`, and `prioritySetBy` (`AI`; a staff change sets `STAFF`). `prioritySetBy` is part of the `Ticket` schema.

**Uploaded images.** An upload lives at S3 key `uploads/<purpose>/<ownerId>/<uploadId>`, where `<purpose>` is `DEFECT` or `REPAIR_PROOF` and `<ownerId>` is the uploader's LINE user ID or staff account ID. An object existing at that key proves its purpose and owner, so `POST /tickets` only checks existence. `POST /uploads` must create objects at exactly this key (`uploadObjectKey()` in `backend/src/shared/upload-store.ts`).

## Rate limit (SR-31, proposal)

`POST /tickets` lets one reporter create 10 tickets per hour (`TICKET_RATE_LIMIT_PER_HOUR`, default 10); the next one gets `429` with code `RATE_LIMITED` and a `Retry-After` header in seconds. The count is one `RateLimits` item per reporter and clock hour (a fixed window), incremented by a single conditional update, so parallel requests cannot pass the limit. Only a request that would create a ticket counts: a retry of an existing ticket (same `Idempotency-Key`), an invalid request and a failed upload check do not. A reporter can send up to twice the limit around the turn of an hour. The per-IP limit of SR-31 is an AWS WAF rule on API Gateway and is not part of this code. The table needs DynamoDB TTL enabled on `expiresAt` (epoch seconds) and must have no stream, so counting never starts a worker.

## Stream consumers

- **AI triage** is triggered by the `Tickets` stream. Every `INSERT` is a new ticket; `MODIFY` events are ignored, which also stops the triage update from re-triggering itself.
- **Notifications** are triggered by the `TicketEvents` stream. Every `INSERT` is an audit event, and its `kind` decides which channels fire. The `Notifications` and `RateLimits` tables are separate and have no consumer.

Both event source mappings need `ReportBatchItemFailures`, a stream view of `NEW_IMAGE` or `NEW_AND_OLD_IMAGES`, a bounded retry count and a small batch size (1-5, because each ticket makes sequential AI calls).

## AI triage (SCFRMS-41)

A new ticket is stored as `RECEIVED` with no category, priority or team. A worker then classifies it and moves it to `ASSIGNED`. Bedrock never writes to DynamoDB: it only proposes values, and backend code validates them and writes the result.

**Flow**

1. The `Tickets` stream delivers the `INSERT`.
2. The worker skips the ticket unless it is still `RECEIVED`, so duplicate stream deliveries cost nothing.
3. Rekognition (`DetectLabels`) reads the defect photo from S3 and returns object labels. If this fails, classification continues from the text alone.
4. Bedrock (Converse API) receives the location, description and labels and replies with `{category, impact, urgency}`. The resident's text is passed as quoted data, never as instructions.
5. Backend code accepts only known values, then computes the rest (below) and writes it in one transaction.

**Rules applied in code** (`backend/src/triage/policy.ts`; proposed defaults from the Security, Roles & SLA requirements, to be confirmed by the juristic office)

| Impact \ Urgency | HIGH     | MEDIUM   | LOW    |
| ---------------- | -------- | -------- | ------ |
| HIGH             | CRITICAL | CRITICAL | MEDIUM |
| MEDIUM           | CRITICAL | MEDIUM   | LOW    |
| LOW              | MEDIUM   | LOW      | LOW    |

| Priority | Hours from `createdAt` to `DONE` |
| -------- | -------------------------------- |
| CRITICAL | 4                                |
| MEDIUM   | 24                               |
| LOW      | 120                              |

The deadline is counted from ticket creation, so slow triage uses up SLA time. The requirements document calls the top priority `HIGH`; `openapi.yaml` calls it `CRITICAL`, and the team chose `CRITICAL`. Each category maps to the team of the same name: `ELECTRICAL`, `PLUMBING`, `HVAC`, `CLEANING_SANITATION`, `BUILDING_EQUIPMENT`.

**Safety override (SLA-02).** Before the matrix is applied, `backend/src/triage/safety.ts` scans the description for English keywords of a safety hazard: `FIRE`, `SMOKE`, `GAS`, `ELECTRIC_SHOCK`, `FLOOD_NEAR_ELECTRICAL` (water together with electrical equipment) or `TRAPPED`. If one matches, `priority` is `CRITICAL` whatever the matrix says, and the deadline is the CRITICAL one (4 hours from `createdAt`). `suggestedPriority` still holds the matrix result. The scan runs in code on the resident's text, not in the AI, so a crafted description cannot lower it. Phrases that name safety equipment (for example "fire extinguisher") or an air-conditioning gas refill do not trigger it.

**Fields set on the ticket.** `status = ASSIGNED`, `category`, `suggestedPriority`, `priority`, `prioritySetBy = AI`, `teamId`, `deadlineAt`, `slaPolicyVersion`, `triagedAt`, `updatedAt`, `version + 1` and `teamStatusKey`. When the safety override applied, `safetyHazard` is also set. It is internal: it is never returned to callers.

**Audit event.** A `TRIAGED` event in `TicketEvents` with `actorType = SYSTEM`, `fromStatus = RECEIVED`, `toStatus = ASSIGNED`, `toPriority`, `toTeamId`, and `note = SAFETY_OVERRIDE:<hazard>` when the override applied (`note` is part of the `TicketEvent` schema). The ticket update and the event are one transaction, conditional on `status = RECEIVED` and the `version` that was read, so a concurrent change makes the whole write fail and nothing is applied twice.

**Failures**

| Case                                                     | Result                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Reply is not JSON, or a value is outside the known lists | Ticket stays `RECEIVED`, logged, not retried. Find it with `?status=RECEIVED`. |
| Ticket not found                                         | Logged, not retried.                                                           |
| Same as the first row, but a safety hazard was detected  | Same, and logged as `Safety hazard report needs manual triage`.                |
| Temporary error (Bedrock throttling, DynamoDB)           | Reported as a batch item failure; Lambda retries from that record.             |
| Photo labelling fails                                    | Classification continues from the text alone.                                  |

**Configuration**

- Environment: `BEDROCK_MODEL_ID` (required, no default), `AWS_REGION`, `UPLOAD_BUCKET_NAME` and the table names above.
- IAM for the worker: `bedrock:InvokeModel`, `rekognition:DetectLabels`, read on S3 `uploads/*`, read and write on the ticket tables.

**Not decided yet**

- Safety keywords are English only. Thai phrases are not detected yet, so a Thai report of fire or gas is triaged by the matrix alone.
- A hazard report the AI could not classify stays `RECEIVED` and is only logged. The 5-minute fallback to the manager's queue as `MEDIUM` (SLA-06) needs the scheduler of SCFRMS-42, and no one is alerted yet.
- The receipt that shows the building security phone number and the emergency numbers 191, 199 and 1669 (SLA-02) belongs to the LINE message of SCFRMS-45.
- Bedrock model ID and region. The worker has not been run against a real model; the impact and urgency wording in the prompt is a first draft to test and tune.
- How a manager finds and re-triages tickets the AI could not classify. For now they are `RECEIVED` tickets in `GET /tickets`; there is no re-run job and no separate queue.
- Per-team SLA hours (the code supports overrides; none are set) and whether reopening a ticket resets its deadline.

## Work order email (SCFRMS-46)

When AI triage assigns a ticket, the assigned team receives a plain-text work order email through Amazon SES.

**Trigger.** The `TRIAGED` event (written in the same transaction as the triage update) starts the notification worker through the `TicketEvents` stream and sends the email. Other event kinds, such as `TICKET_CREATED`, trigger nothing yet; SCFRMS-45 (LINE messages) will add channels to the same worker.

**No duplicates.** The stream can deliver a record more than once, and the API contract says retries must not send duplicates. For each audit event and channel the worker checks the `Notifications` table, sends, then writes the record:

| Field             | Value                                         |
| ----------------- | --------------------------------------------- |
| `ticketId`        | the ticket (PK)                               |
| `notificationKey` | `<eventId>#<channel>` (SK)                    |
| Other fields      | `eventId`, `channel` (`EMAIL_TEAM`), `sentAt` |

The record is written with `attribute_not_exists(ticketId)`, so writing it twice is harmless. Delivery is at-least-once: if the worker fails between the send and the write, the email can be sent twice, but it is never lost.

**Recipient.** The `email` field of the team's record in the `Teams` table. While `TEAMS_TABLE_NAME` is not set, or the record has no address, the `TEAM_EMAILS` environment variable is the fallback.

**Email.** Subject: `[<priority>] Work order <ticketId> - <teamId>`. The subject only contains values the system generated, never text written by a resident. The body lists the ticket id, priority, category, location, report time, deadline (shown as Asia/Bangkok time; stored times stay UTC) and description, plus a link when `ADMIN_DASHBOARD_URL` is set. The link format `<ADMIN_DASHBOARD_URL>/tickets/<ticketId>` is an assumption to confirm with the admin dashboard.

**Failures**

| Case                                                        | Result                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Team has no address in `Teams` or `TEAM_EMAILS`             | Logged as an error, nothing recorded, not retried.                 |
| Ticket no longer exists                                     | Logged, not retried.                                               |
| SES, `Teams` or DynamoDB error, or `SES_SENDER_EMAIL` unset | Reported as a batch item failure; Lambda retries from that record. |

**Configuration**

- Environment: `SES_SENDER_EMAIL`, `TEAMS_TABLE_NAME` (optional until the table exists), `TEAM_EMAILS` (JSON object of team id to address, for example `{"PLUMBING": "plumbing@example.com"}`, the fallback), optional `ADMIN_DASHBOARD_URL`, `AWS_REGION` and the table names above.
- IAM for the worker: `ses:SendEmail`, read on `Tickets`, `TicketPhotos` and `Teams`, and read and write on `Notifications`.
- SES: the sender address or domain must be verified. A new SES account starts in sandbox mode, which only delivers to verified addresses, so request production access before real use.

**Not decided yet**

- The admin dashboard URL and ticket page path.
- Whether a ticket that is re-assigned or reopened should send a new work order; only the first triage sends one today.
