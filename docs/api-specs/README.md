# API design draft (SCFRMS-31)

This is a **proposed contract for review**, not an implemented API. The reporter intake sequence below was confirmed by the project owner on 2026-10-10; other rules remain draft. The machine-readable draft is [openapi.yaml](openapi.yaml). It uses `/v1` as a proposed base path; the listed resource paths begin with `/tickets`, `/uploads`, and so on.

Sources: the kick-off PDF's functional requirements (FR1–FR5), [SCFRMS-31](https://kaminsirisu.atlassian.net/browse/SCFRMS-31), related Jira tasks, and the repository's [database notes](../database/README.md). Requirements are still being revised. Confluence was not accessible during this review.

## What `/tickets` and `/messages` mean

`/tickets` is the main public resource. A report creates a ticket; staff change its priority and status; reporters can see and reopen their own tickets; staff can merge duplicates. Every state change records an audit event.

There is **no public `/messages` endpoint in this draft**. The stated requirement is automated LINE submission receipts, progress/completion notices, and supervisor escalation alerts. Those are effects of ticket events, delivered by an internal notification worker. Neither reporters nor staff compose messages through this product. If two-way chat becomes a requirement, design a separate message resource then. A LINE Messaging API webhook, if needed for button postbacks, would be a provider callback such as `POST /webhooks/line`, not a client-facing `/messages` endpoint.

## Proposed endpoints

| Method and path                                    | Caller                                  | Behavior                                                                                                    |
| -------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /health`                                      | Anyone                                  | Service health only.                                                                                        |
| `POST /uploads`                                    | Reporter or staff                       | Obtain a short-lived S3 upload URL for a defect or repair proof image.                                      |
| `POST /tickets`                                    | Reporter via LIFF                       | Create a report using a completed defect upload; return its ticket ID immediately and queue a receipt.      |
| `GET /tickets`                                     | Reporter or staff                       | Reporter sees only associated tickets; staff can filter their work, the queue, or completed repair history. |
| `GET /tickets/{ticketId}`                          | Associated reporter or authorized staff | Current ticket detail and caller-visible photo metadata, including canonical target when merged.            |
| `GET /tickets/{ticketId}/photos/{photoId}/access`  | Associated reporter or authorized staff | Issue a short-lived read URL after checking access to that specific photo.                                  |
| `GET /tickets/{ticketId}/events`                   | Staff                                   | Audit history for status, priority, merge, and reopen actions.                                              |
| `PATCH /tickets/{ticketId}/priority`               | Assigned-team technician or manager     | Change the suggested or current priority with a reason and audit event.                                     |
| `POST /tickets/{ticketId}/accept`                  | Assigned-team technician                | Record individual acceptance while the ticket stays `ASSIGNED`.                                             |
| `PATCH /tickets/{ticketId}/assignment`             | Manager                                 | Reassign unstarted work to another team with a reason; clear prior technician acceptance.                   |
| `PATCH /tickets/{ticketId}/status`                 | Accepting technician                    | Move work to `IN_PROGRESS` or `DONE`; `DONE` requires uploaded proof.                                       |
| `POST /tickets/{ticketId}/reopen`                  | Associated reporter                     | Reopen a `DONE` ticket, record why, and notify staff.                                                       |
| `POST /tickets/{ticketId}/merge`                   | Authorized technician                   | Merge verified same-problem source tickets into this canonical ticket.                                      |
| `GET /dashboard/summary`                           | Manager                                 | Counts, overdue work, and team workloads.                                                                   |
| `GET /dashboard/history`                           | Manager                                 | Paginated current and previous tickets with repair totals and optional filters.                             |
| `POST /auth/staff/login`                           | Staff                                   | Exchange credentials for a staff session token; auth design is still open.                                  |
| `GET /auth/staff/me`                               | Staff                                   | Current role and team.                                                                                      |
| `POST /internal/tickets/{ticketId}/classification` | Trusted service only                    | Proposed callback for AI suggestions; never exposed to a browser.                                           |

## Proposed ticket behavior

1. LIFF obtains a LINE token. The backend verifies it and derives reporter identity from the token; the request must not supply a trusted LINE user ID.
2. The client requests an upload URL, uploads the image directly to S3, and calls `POST /tickets` with the resulting upload ID, a free-text `location` entered by the reporter, and a description. There is no zone ID or location catalog. The API validates the uploaded object before accepting it. A repeated `Idempotency-Key` must not create a second ticket.
3. Creation returns `201` with status `RECEIVED` after the backend stores the report, generated ticket ID, verified LINE user ID, and S3 image reference in DynamoDB. Priority and team are absent at this point. This durable intake happens before AI classification.
4. A background worker sends the description and image to the chosen AI service. Bedrock returns category, priority, and team suggestions; backend code validates them and conditionally updates the ticket with the selected priority, assigned team, deadline, and status `ASSIGNED`. Bedrock does not write directly to DynamoDB. A failed classification must leave the report available for retry or manual triage.
5. An assigned-team technician may accept an `ASSIGNED` ticket without starting work. The accepting technician then moves `ASSIGNED → IN_PROGRESS → DONE`; completing requires a verified repair-proof upload. A technician on the assigned team or a manager may change priority with a reason. Managers monitor current work and may reassign an unstarted `ASSIGNED` ticket, clearing any prior acceptance. Each action records an audit event. Invalid transitions return `409`, while missing or invalid proof returns `422`.
6. A reporter associated with a `DONE` ticket may reopen it. This draft uses `DONE → ASSIGNED`, clears the earlier acceptance and current `completedAt`, increments `repairCycle`, and records a `REOPENED` audit event. Earlier completion and proof photos remain in history. The deadline reset policy remains undecided.
7. An authorized technician may merge reports after confirming the same physical problem. Merging marks source tickets `MERGED` and records their canonical ticket ID; the original report, photos, and audit events remain on each source. The canonical ticket keeps all reporter associations so everyone still sees updates and can access the repair. The technician reviews the free-text locations and issue details; matching location text alone does not establish a duplicate. The technician must have access to all tickets involved. Cross-team merges and the exact issue-matching rule need approval.
8. Successful ticket actions produce internal notification events. LINE delivery is asynchronous: a successful API response means the action was saved and notification work was queued, not that LINE delivered a message. Retries must not send duplicates. The manager's deadline alert comes from the SLA worker, not a public API call.

Reporter and staff screens can poll `GET /tickets/{ticketId}` or the relevant list/dashboard endpoint for fresh state. A push or streaming API is not part of this draft; the refresh policy needs confirmation. The PDF's mobile ticket-creation response target is under 2.5 seconds, which favors returning after durable intake and doing AI triage and LINE delivery asynchronously.

The draft status values are `RECEIVED`, `ASSIGNED`, `IN_PROGRESS`, `DONE`, and `MERGED`. `RECEIVED` is the confirmed intake state. `MERGED` remains proposed for duplicate handling; the PDF explicitly names the technician states `ASSIGNED`, `IN_PROGRESS`, and `DONE`.

## Manager monitoring and repair history

Managers can list all current tickets through `GET /tickets`, monitor status counts and team workloads through `GET /dashboard/summary`, and browse all current and previous ticket records through `GET /dashboard/history`. The history view includes active, completed, reopened, and merged records. It returns a paginated list plus counts across all matching records: tickets by current status, priority, and team, and total completion and reopen events. Per-ticket completion and reopen counts show earlier repair cycles even when a reopened ticket is currently `ASSIGNED`. Staff can open `GET /tickets/{ticketId}/events` for the detailed repair log and access proof photos through the photo-access endpoint. These are proposed useful metrics; the exact dashboard presentation remains open.

The number of maintenance teams and the resolution time for each priority are deferred. Team IDs therefore have no fixed list here, and no SLA duration or countdown formula is hard-coded. `deadlineAt` and overdue counts depend on an approved SLA policy; until then, an interface must not present an unconfigured deadline as a met deadline.

## Access and response rules

- Reporter endpoints require a verified LINE credential but no account registration. A ticket ID alone is never proof of access. A reporter may access a canonical ticket only while associated with it, including after a merge.
- Staff endpoints require a staff credential and backend role checks. Technicians can read and act on their assigned team's work and merge verified duplicates within their authorized scope; managers can monitor building-wide data, reassign work, and change priority. Ordinary status updates belong to the accepting technician. Any manager status override would need its own exception rule and audit record. The precise staff login, token, and IAM boundary must be confirmed.
- The ticket response omits LINE user IDs, password hashes, internal notification metadata, raw S3 keys, and persistent photo URLs. `acceptedByStaffId` is staff-visible only. Its `photos` array contains metadata filtered for the caller: a reporter sees their own defect photos and repair proof for an associated repair; authorized staff see photos within their work scope. `GET /tickets/{ticketId}/photos/{photoId}/access` checks that photo's ownership and returns a short-lived read URL. Defect and repair-proof images remain separate, including across merges and reopen cycles.
- Lists use cursor pagination. Writes use an idempotency key where retries might duplicate work. Concurrent updates should use a version or ETag check; the exact mechanism remains open.
- Errors use one envelope with a stable code, readable message, and request ID. Typical responses are `400` (malformed request), `401` (no valid credential), `403` (not allowed), `404` (not found or hidden), `409` (state conflict), `422` (valid shape but failed business validation), and `429` (rate limit).

## Internal notification event, not an HTTP message resource

An internal event can carry `eventId`, `ticketId`, `kind`, `occurredAt`, and a recipient reference resolved by the notification worker. Proposed kinds are `SUBMISSION_RECEIPT`, `ASSIGNED`, `STATUS_CHANGED`, `COMPLETED`, `REOPENED`, and `SLA_BREACHED`. It must not expose a client-supplied recipient LINE ID. Delivery attempts and failures belong in internal operations data, not the public ticket response.

## Decisions needed before implementation

1. Reconcile [SCFRMS-40](https://kaminsirisu.atlassian.net/browse/SCFRMS-40)'s older immediate-`ASSIGNED` wording with the confirmed `RECEIVED`-then-classify flow. Define AI retry/manual triage and when the SLA clock starts.
2. Confirm the exact LINE token type, verification flow, and whether all reporter actions happen in LIFF. Confirm staff authentication and role model; the PDF mentions IAM RBAC while the repository proposes staff JWTs.
3. Confirm any length or input rules for free-text `location`, and decide whether exact-text location filters and history grouping are useful despite spelling variations. The number of teams and the SLA duration/countdown for each priority are deferred. Later, approve team and domain codes, the SLA matrix, and deadline behavior after priority changes, merges, and reopenings ([SCFRMS-27](https://kaminsirisu.atlassian.net/browse/SCFRMS-27)).
4. Set image formats, size limits, malware/content checks, upload expiry, and when an upload counts as verified ([SCFRMS-36](https://kaminsirisu.atlassian.net/browse/SCFRMS-36)).
5. Review the remaining role details: assigned-team technician accepts and changes status; technician or manager changes priority with a reason; authorized technician merges duplicates; manager monitors work and reassigns unstarted tickets; associated reporter reopens. Decide whether managers need an audited status override, how to reassign work already `IN_PROGRESS`, whether staff can reopen for a reporter, and whether cross-team merges require manager involvement. Confirm the exact duplicate-matching rule, historical reporting filters, and which summary numbers managers need.
6. Decide whether the AI worker needs an HTTP callback at all. An internal event or direct Lambda invocation may be preferable; the proposed callback is present to cover [SCFRMS-31](https://kaminsirisu.atlassian.net/browse/SCFRMS-31)'s scope.
7. Confirm LINE notification eligibility, retry policy, templates, and whether a LINE webhook is needed ([SCFRMS-45](https://kaminsirisu.atlassian.net/browse/SCFRMS-45)).

No endpoint in this document is approved for implementation merely by appearing in the draft.
