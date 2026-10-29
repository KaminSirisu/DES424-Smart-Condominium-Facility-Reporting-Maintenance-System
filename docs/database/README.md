# Database design

Document DynamoDB tables, partition/sort keys, indexes, and access patterns before implementing data helpers. Include tickets with reporter-entered free-text `location`, staff accounts and roles, reporter-to-ticket associations, deadlines, and status audit events. No zone ID or zone catalog is planned.

Define how merged tickets retain reporter associations, how reopening affects deadlines, and how managers query historical data.

The manager history view must include current and previous ticket records, including reopened and merged tickets. Preserve completion and reopen events, proof-photo references, and original source reports so earlier repair cycles remain available after a ticket reopens or merges. Design the ticket and event access patterns for paginated history and aggregate counts; the exact table keys and indexes are still open.

## Staff account record — draft for team review

The team's original example has the core information needed for a technician. The only edit below is removing the backslash before `@` so the example is valid JSON:

```json
{
  "email": "plumbing@condocare.com",
  "passwordHash": "$2b$10$...",
  "name": "Somchai (Plumbing)",
  "role": "TECHNICIAN",
  "team": "Plumbing Team"
}
```

Proposed revision:

```json
{
  "email": "plumbing@condocare.com",
  "staffId": "staff_001",
  "passwordHash": "$argon2id$...",
  "name": "Somchai",
  "role": "TECHNICIAN",
  "teamId": "PLUMBING",
  "status": "ACTIVE",
  "createdAt": "2026-09-12T10:00:00Z",
  "updatedAt": "2026-09-12T10:00:00Z"
}
```

For a simple dedicated `Staff` table, use normalized lowercase `email` as the partition key for direct login lookup and unique email addresses. Keep `staffId` as a separate, stable identifier for ticket assignments. Changing an email would require moving the staff item to a new key while preserving `staffId`; decide that flow before implementation. `teamId` is a consistent code for filtering and assignment, while a display name such as “Plumbing Team” can be defined separately. `status` allows an account to be disabled without deleting its repair history.

Store only a password hash, never a plaintext password. The original `$2b$10$...` placeholder represents bcrypt; the proposed `$argon2id$...` represents Argon2id. Choose and document one algorithm before creating real staff accounts. JWTs are issued at login and verified by protected endpoints; they are not staff-record fields and do not need to be stored here. Never return `passwordHash` in API responses.

Team decisions still open: exact role and team codes, whether email changes are supported, the password-hash algorithm, and whether disabling an account must invalidate an already issued JWT immediately.

## Ticket items — implemented in SCFRMS-40 (proposal for team review)

One DynamoDB table (`TABLE_NAME`). Everything about a ticket shares the partition `TICKET#<ticketId>`, so a single Query reads the ticket, its reporters and its audit events together. Reporter-to-ticket links and audit events are separate items, so a merged ticket can carry several reporters and a full history.

| Item          | PK            | SK                                 | Other keys                                                       |
| ------------- | ------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Ticket        | `TICKET#<id>` | `METADATA`                         | GSI1 added at triage (see below); GSI3 still to come             |
| Reporter link | `TICKET#<id>` | `REPORTER#<lineUserId>`            | `GSI2PK = REPORTER#<lineUserId>`, `GSI2SK = CREATED#<createdAt>` |
| Audit event   | `TICKET#<id>` | `EVENT#<occurredAt>#<kind>`        | none                                                             |
| Notification  | `TICKET#<id>` | `NOTIFICATION#<eventId>#<channel>` | none                                                             |

Each item also carries `entityType` (`TICKET`, `TICKET_REPORTER`, `TICKET_EVENT`, `TICKET_NOTIFICATION`). The three items for a new ticket are written in one transaction; the ticket Put is conditional (`attribute_not_exists(PK)`), so a duplicate id cancels the whole write.

**Ticket id.** `tkt_` plus the first 26 hex characters of `sha256(lineUserId + "\n" + Idempotency-Key)`. A retry with the same key reaches the same item; two reporters using the same key never collide.

**Ticket record fields.** The fields of the `Ticket` schema in `openapi.yaml`, plus internal-only `reporterLineUserId` (the original reporter), `version` (optimistic-locking counter, starts at 1) and, on each photo, `s3ObjectKey`. None of the internal fields, and no key attribute, is returned to callers.

**Access patterns**

| Need                             | Query                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| One ticket                       | Get `TICKET#<id>` / `METADATA`                                         |
| Ticket with reporters and events | Query PK `TICKET#<id>`                                                 |
| A reporter's tickets             | Query GSI2 with `GSI2PK = REPORTER#<lineUserId>`, then get each ticket |
| Audit history of a ticket        | Query PK `TICKET#<id>` with SK `begins_with EVENT#`                    |

**Uploaded images.** An upload lives at S3 key `uploads/<purpose>/<ownerId>/<uploadId>`, where `<purpose>` is `DEFECT` or `REPAIR_PROOF` and `<ownerId>` is the uploader's LINE user ID or staff account ID. An object existing at that key proves its purpose and owner, so `POST /tickets` only checks existence. `POST /uploads` must create objects at exactly this key (`uploadObjectKey()` in `backend/src/shared/upload-store.ts`).

**Not decided yet**

- GSI1 (team queue) is set by SCFRMS-41 at triage. GSI3 (status) is not built yet. SCFRMS-42 needs an index that finds open tickets by deadline.
- Team records (email address, SLA hours per priority) are not defined; SCFRMS-41, 42 and 46 need them.
- Manager history queries and aggregate counts remain open, as listed at the top of this document.
- Stream consumers must filter on `INSERT` and `entityType`, because every item written appears in the stream: triage reacts to `TICKET`, and notifications react to `TICKET_EVENT` (by `kind`). Both ignore the other items, including `TICKET_NOTIFICATION` records.

## AI triage — implemented in SCFRMS-41 (proposal for team review)

A new ticket is stored as `RECEIVED` with no category, priority or team. A worker then classifies it and moves it to `ASSIGNED`. Bedrock never writes to DynamoDB: it only proposes values, and backend code validates them and writes the result.

**Flow**

1. The DynamoDB Stream delivers the `INSERT` of the ticket item (`entityType = TICKET`). The reporter link and audit event items also appear in the stream and are ignored, as are `MODIFY` events, so the triage update does not trigger itself.
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

**Fields set on the ticket.** `status = ASSIGNED`, `category`, `suggestedPriority`, `priority`, `teamId`, `deadlineAt`, `slaPolicyVersion`, `triagedAt`, `updatedAt`, `version + 1`, and the team-queue keys `GSI1PK = TEAM#<teamId>`, `GSI1SK = DEADLINE#<deadlineAt>`. `suggestedPriority` and `priority` are equal at triage; a later manual change (`/priority`) alters only `priority`.

**Audit event.** `SK = EVENT#<now>#TRIAGED`, `actorType = SYSTEM`, `fromStatus = RECEIVED`, `toStatus = ASSIGNED`, `toPriority`, `toTeamId`. The update and the event are one transaction, conditional on `status = RECEIVED` and the `version` that was read, so a concurrent change makes the whole write fail and nothing is applied twice.

**Failures**

| Case                                                     | Result                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Reply is not JSON, or a value is outside the known lists | Ticket stays `RECEIVED`, logged, not retried. Find it with `?status=RECEIVED`. |
| Ticket not found                                         | Logged, not retried.                                                           |
| Temporary error (Bedrock throttling, DynamoDB)           | Reported as a batch item failure; Lambda retries from that record.             |
| Photo labelling fails                                    | Classification continues from the text alone.                                  |

**Configuration**

- Environment: `BEDROCK_MODEL_ID` (required, no default), `AWS_REGION`, `TABLE_NAME`, `UPLOAD_BUCKET_NAME`.
- IAM for the worker: `bedrock:InvokeModel`, `rekognition:DetectLabels`, read on S3 `uploads/*`, read and write on the table.
- Stream and event source mapping: stream view `NEW_IMAGE` or `NEW_AND_OLD_IMAGES`, `ReportBatchItemFailures` enabled, a bounded retry count, and a small batch size (1-5) because each ticket makes sequential AI calls.

**Not decided yet**

- Bedrock model ID and region. The worker has not been run against a real model; the impact and urgency wording in the prompt is a first draft to test and tune.
- How a manager finds and re-triages tickets the AI could not classify. For now they are `RECEIVED` tickets in `GET /tickets`; there is no re-run job and no separate queue.
- Per-team SLA hours (the code supports overrides; none are set) and whether reopening a ticket resets its deadline.

## Work order email — implemented in SCFRMS-46 (proposal for team review)

When AI triage assigns a ticket, the assigned team receives a plain-text work order email through Amazon SES.

**Trigger.** Every ticket change writes an audit event item, and its `INSERT` in the DynamoDB Stream starts the notification worker. The `TRIAGED` event (written in the same transaction as the triage update) sends the email. Other event kinds, such as `TICKET_CREATED`, trigger nothing yet; SCFRMS-45 (LINE messages) will add channels to the same worker.

**No duplicates.** The stream can deliver a record more than once, and the API contract says retries must not send duplicates. For each audit event and channel the worker checks for a notification record, sends, then writes the record:

| Field        | Value                                                     |
| ------------ | --------------------------------------------------------- |
| `PK` / `SK`  | `TICKET#<id>` / `NOTIFICATION#<eventId>#<channel>`        |
| `entityType` | `TICKET_NOTIFICATION`                                     |
| Other fields | `ticketId`, `eventId`, `channel` (`EMAIL_TEAM`), `sentAt` |

The record is written with `attribute_not_exists(PK)`, so writing it twice is harmless. Delivery is at-least-once: if the worker fails between the send and the write, the email can be sent twice, but it is never lost.

**Email.** Subject: `[<priority>] Work order <ticketId> - <teamId>`. The subject only contains values the system generated, never text written by a resident. The body lists the ticket id, priority, category, location, report time, deadline (shown as Asia/Bangkok time; stored times stay UTC) and description, plus a link when `ADMIN_DASHBOARD_URL` is set. The link format `<ADMIN_DASHBOARD_URL>/tickets/<ticketId>` is an assumption to confirm with the admin dashboard.

**Failures**

| Case                                               | Result                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Team has no address in `TEAM_EMAILS`               | Logged as an error, nothing recorded, not retried.                 |
| Ticket no longer exists                            | Logged, not retried.                                               |
| SES or DynamoDB error, or `SES_SENDER_EMAIL` unset | Reported as a batch item failure; Lambda retries from that record. |

**Configuration**

- Environment: `TEAM_EMAILS` (JSON object of team id to address, for example `{"PLUMBING": "plumbing@example.com"}`; teams have no record in the database yet), `SES_SENDER_EMAIL`, optional `ADMIN_DASHBOARD_URL`, `AWS_REGION`, `TABLE_NAME`.
- IAM for the worker: `ses:SendEmail`, and read and write on the table.
- SES: the sender address or domain must be verified. A new SES account starts in sandbox mode, which only delivers to verified addresses, so request production access before real use.
- Stream and event source mapping: stream view `NEW_IMAGE` or `NEW_AND_OLD_IMAGES`, `ReportBatchItemFailures` enabled, a bounded retry count, and a small batch size.

**Not decided yet**

- Where team email addresses should live. `TEAM_EMAILS` is a stopgap until team records exist (also needed by SCFRMS-42).
- The admin dashboard URL and ticket page path.
- Whether a ticket that is re-assigned or reopened should send a new work order; only the first triage sends one today.
