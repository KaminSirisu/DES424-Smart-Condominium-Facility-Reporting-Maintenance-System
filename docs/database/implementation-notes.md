# Backend implementation notes

What the backend code stores and reads today (SCFRMS-40, 41, 45, 46, the SLA-02 safety override and the SR-31 rate limit). The table keys follow the proposal in [DynamoDB access patterns](dynamodb-access-patterns.md) (SCFRMS-28). This file only records what the code does and where it adds to that proposal; additions are marked as proposals for team review. Nothing here has been run against real AWS yet; the tests use mocks.

## Tables used

Each table name comes from an environment variable (`backend/src/shared/tables.ts`), so the infrastructure decides the real names.

| Table             | Environment variable          | Keys and indexes                                                                                                   | Written by                                 |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `Tickets`         | `TICKETS_TABLE_NAME`          | PK `ticketId`; `TeamOpenIndex` (`teamStatusKey`, `createdKey`); `CreatedMonthIndex` (`createdMonth`, `createdKey`) | `POST /tickets`, AI triage                 |
| `TicketReporters` | `TICKET_REPORTERS_TABLE_NAME` | PK `ticketId`, SK `reporterLineUserId`; `ReporterTicketsIndex` (`reporterLineUserId`, `associatedKey`)             | `POST /tickets`; read by the LINE channel  |
| `TicketPhotos`    | `TICKET_PHOTOS_TABLE_NAME`    | PK `ticketId`, SK `photoId`                                                                                        | `POST /tickets`                            |
| `TicketEvents`    | `TICKET_EVENTS_TABLE_NAME`    | PK `ticketId`, SK `eventKey` = `<occurredAt>#<eventId>`                                                            | `POST /tickets`, AI triage                 |
| `Notifications`   | `NOTIFICATIONS_TABLE_NAME`    | PK `ticketId`, SK `notificationKey` = `<eventId>#<channel>:<recipient>`                                            | notification worker (proposal)             |
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
- **Notifications** are triggered by the `TicketEvents` stream. Every `INSERT` is an audit event, and its `kind` decides which channels fire (work order email, LINE messages). The `Notifications` and `RateLimits` tables are separate and have no consumer.

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
- The receipt with the emergency numbers 191, 199 and 1669 (SLA-02) is built in the LINE messages of SCFRMS-45 (below); it still needs the real building security phone number.
- Bedrock model ID and region. The worker has not been run against a real model; the impact and urgency wording in the prompt is a first draft to test and tune.
- How a manager finds and re-triages tickets the AI could not classify. For now they are `RECEIVED` tickets in `GET /tickets`; there is no re-run job and no separate queue.
- Per-team SLA hours (the code supports overrides; none are set) and whether reopening a ticket resets its deadline.

## Work order email (SCFRMS-46)

When AI triage assigns a ticket, the assigned team receives a plain-text work order email through Amazon SES.

**Trigger.** The `TRIAGED` event (written in the same transaction as the triage update) starts the notification worker through the `TicketEvents` stream and sends the email. `TICKET_CREATED` does not send email; it sends the LINE receipt (see LINE messages below).

**No duplicates.** The stream can deliver a record more than once, and the API contract says retries must not send duplicates. For each audit event, channel and recipient the worker checks the `Notifications` table, sends, then writes the record. The email has one recipient, the ticket's team, so its key looks like `tkt_1_triaged#EMAIL_TEAM:PLUMBING`:

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| `ticketId`        | the ticket (PK)                        |
| `notificationKey` | `<eventId>#<channel>:<recipient>` (SK) |
| Other fields      | `eventId`, `channel`, `sentAt`         |

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

## LINE messages (SCFRMS-45)

The reporter gets Flex Messages in LINE, pushed by the same notification worker as the work order email. The message builders are in `backend/src/notifications/line-flex.ts` and the channel in `line-notification.ts`.

**Recipients.** Every reporter of the ticket, read from the `TicketReporters` table, so a ticket merged from several reports reaches everyone. Each reporter is tracked on their own in the notification log, using a key such as `tkt_1_triaged#LINE_REPORTER:<lineUserId>`. A LINE user id is stored in that key but never written to application logs (SR-35): logs only name the channel.

**Messages**

| Audit event kind | Message                                                          | State                                               |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `TICKET_CREATED` | Receipt with the ticket id, location and time                    | Sent                                                |
| `TRIAGED`        | Assignment notice naming the team                                | Sent                                                |
| `IN_PROGRESS`    | Work started notice                                              | Builder ready; sent once SCFRMS-43 writes the event |
| `DONE`           | Completion notice with the proof photo, View details and Re-open | Builder ready; sent once SCFRMS-43 writes the event |
| `MERGED`         | Merge notice                                                     | Not built; belongs to SCFRMS-44                     |

**Content rules** (Security, Roles & SLA requirements)

- SLA-02: every receipt says this chat is not an emergency channel and lists the Thai emergency numbers 191 (police), 199 (fire) and 1669 (ambulance), plus building security's number and a call button when `BUILDING_SECURITY_PHONE` is set. A receipt whose description matches a safety hazard keyword also gets a red "possible emergency" banner. The numbers are on every receipt, not only the detected ones, because the keyword scan is English only and a Thai report of a fire would otherwise get no numbers.
- SR-32: resident-written text is cut to a short length and stripped of control characters. The description is never copied into a message; only the location is, shortened.
- RR-04: the reporter sees the team name only, never staff names or internal notes.
- The assignment and later messages carry no priority or deadline.

**Buttons open the LIFF app** (proposal). "View report" and "View details and photo" open `<LIFF_URL>/tickets/<ticketId>`; "Re-open" opens `<LIFF_URL>/tickets/<ticketId>/reopen`. The LIFF app calls the API with the reporter's LINE token, which `POST /tickets/{ticketId}/reopen` needs, and the page can ask `GET /tickets/{ticketId}/photos/{photoId}/access` for a fresh photo link. Because buttons open a page instead of sending a postback to a webhook, there is no LINE webhook and SR-06 (check `X-Line-Signature`) does not apply. Add a webhook only if a postback button is introduced later.

**Proof photo** (proposal from the backend developer, for the team to confirm; to build with SCFRMS-43). The completion notice shows the repair photo, because the Jira task asks for it. LINE only shows an image in a Flex Message when it is an HTTPS JPEG or PNG of at most 1024 by 1024 pixels and about 1 MB, and a phone photo is much bigger. So the backend, not the technician or the reporter, makes a small copy:

1. The technician uploads the original photo as today; the original stays in S3 as the record.
2. When the `DONE` event arrives, the worker reads the original, makes a JPEG of at most 1024 pixels and under 1 MB, and stores it under a separate S3 prefix (an existing copy is reused on a retry).
3. The worker signs a short-lived read URL for the small copy (`PROOF_PHOTO_URL_TTL_SECONDS`, proposed default 3600) and puts it in the card.
4. If the copy cannot be made (unsupported or broken file), the card is sent without a photo and the buttons still work.

The signed URL expires sooner than the message stays in the chat, so an old card no longer shows the photo; the reporter taps "View details and photo" to see the full photo through the LIFF page. The ticket API still never returns a permanent photo URL or an S3 key.

**Failures**

| Case                                                         | Result                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| LINE rejects the message for good (for example status 400)   | Logged with the status, nothing recorded, not retried.             |
| Temporary LINE error (401, 403, 429, 5xx) or any other error | Reported as a batch item failure; Lambda retries from that record. |
| One reporter fails after another was messaged                | The first is already recorded and is skipped on the retry.         |
| LINE already accepted the same retry key (status 409)        | Counted as sent; LINE remembers a retry key for 24 hours.          |

**Configuration**

- Environment: `LINE_CHANNEL_ACCESS_TOKEN`, `BUILDING_SECURITY_PHONE` (optional), `LIFF_URL` (optional; buttons are left out when it is not an https URL) and the table names above. SR-34 says the channel secret and access token must live in AWS Secrets Manager, not in files or Git, so the infrastructure should fill `LINE_CHANNEL_ACCESS_TOKEN` from there at deploy time.
- IAM for the worker: read on `Tickets`, `TicketPhotos` and `TicketReporters`, and read and write on `Notifications`. SCFRMS-43 adds read and write on the S3 thumbnail prefix and read on the originals.
- LINE: the LIFF channel and the Messaging API channel must sit under the same LINE provider, and the reporter must have added the Official Account as a friend, or the push fails (SR-05).

### Who needs to do what

| Who                                         | What                                                                                                                                                                                                                                                             | Needed for                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Backend developer                           | SCFRMS-43: the status API that writes the `IN_PROGRESS` and `DONE` events. Then add the completion channel, the small photo copy, the signed URL (`@aws-sdk/s3-request-presigner` and an image library are not installed yet) and `PROOF_PHOTO_URL_TTL_SECONDS`. | Work started and completion messages      |
| Backend developer                           | `POST /tickets/{ticketId}/reopen`: only for a `DONE` ticket within 7 days (RR-03), a `REOPENED` event, a new SLA clock (SLA-10). Proposed to be built together with SCFRMS-43; it needs its own Jira task, because no task covers it today.                      | Re-open button                            |
| Backend developer                           | `GET /tickets/{ticketId}/photos/{photoId}/access` (short-lived read link after an access check). Also not covered by a Jira task today.                                                                                                                          | View details and photo button             |
| Backend developer                           | The merge notice, with SCFRMS-44.                                                                                                                                                                                                                                | Merge message                             |
| Frontend developer                          | In the LIFF app: add routing and the pages `/tickets/<ticketId>` (details and photos) and `/tickets/<ticketId>/reopen` (ask for a reason, then call the reopen API with the LINE token and an `Idempotency-Key`). The LIFF app has no router yet.                | All message buttons                       |
| Frontend developer                          | Ask the reporter to add the Official Account as a friend in the LIFF flow (SR-05).                                                                                                                                                                               | The reporter can receive any push message |
| Infrastructure owner                        | Create the tables, the streams and the event source mappings (see Stream consumers); store the LINE channel access token in Secrets Manager; give the worker the IAM above; package the image library for Lambda (native code that must be built for Linux).     | Everything in this section                |
| Whoever manages the LINE Developers Console | Register the LIFF app and set its endpoint URL so that `<LIFF_URL>/tickets/<ticketId>` opens the right page; keep both channels under one provider.                                                                                                              | Message buttons                           |
| Juristic office (building management)       | Give the building security phone number for `BUILDING_SECURITY_PHONE`. Do not use a made-up number; without one the receipt still lists 191, 199 and 1669.                                                                                                       | SLA-02 receipt before real use            |
| Team                                        | Confirm the proposals above: the LIFF page paths, the small photo copy made by the backend, and who builds the reopen and photo access endpoints.                                                                                                                | Before SCFRMS-43 starts                   |

**Not decided yet**

- Who builds the reopen and photo access endpoints, and whether they get their own Jira tasks.
- Image format and size checks at upload (the S3 content type and size check is still open); a file LINE cannot show falls back to a card without the photo.
- Whether the work started notice (`IN_PROGRESS`) should be sent for every ticket or only for tickets of some priority.
