# Staff portal

This app will provide email/password login, technician task views, and manager views. Planned actions include accepting or changing priority, moving a ticket through its allowed statuses, uploading repair proof, merging duplicates, and viewing deadlines and historical reports.

Folders:

- `src/pages/`: admin pages; `src/pages/tech/` holds the technician (Staff UI) pages.
- `src/components/`: shared ticket and dashboard components.
- `src/services/`: API types, the staff session, and ticket data (currently mocked).
- `src/hooks/`: shared React hooks.
- `src/utils/`: pure helpers such as time formatting.

The backend, not just the UI, must authorize technician and manager actions. A `Dockerfile` should be added when the app has a real build and serving command. The container can then be deployed on ECS Fargate if the team pursues the course bonus.

From the repository root, run `npm ci` and then `npm run dev:admin`. The local page is at `http://127.0.0.1:5174`. Copy this folder's `.env.example` to `.env` to customize the public page title. Run `npm run build --workspace @scfrms/admin-dashboard` to build it. There is no login yet; both areas are open while auth is undecided.

## Admin dashboard

Manager screens. Every page is currently a placeholder.

Route map:

- `/`: maintenance overview (placeholder)
- `/tickets`: ticket list (placeholder)
- `/staff`: staff management (placeholder)
- `/history`: repair history (placeholder)
- `/settings`: settings (placeholder)

How it works: `AdminLayout` renders the `Sidebar` once, and each page renders inside its `<Outlet />`.

How to add a page: create the page in `src/pages/`, add a child route under `/` in `App.tsx`, and add an item to `navItems` in `Sidebar.tsx`.

## Staff UI

Mobile screens for technicians: see the team's jobs, start work, upload a proof-of-repair photo, mark the job done, review the AI priority, merge duplicates, and read the job history. It is a separate top-level route with its own phone-width layout, so the admin sidebar never appears.

Route map:

- `/tech`: job list with "Team jobs" (ASSIGNED and IN_PROGRESS) and "Completed" (DONE) tabs. The tab is kept in the URL (`?tab=completed`) so Back returns to it.
- `/tech/jobs/:ticketId`: job detail, actions, priority review, duplicates, and history.
- `/tech/*`: technician 404 page.

Main files:

- `layouts/TechLayout.tsx`: phone-width frame. Each page renders its own `TechHeader` (title, subtitle, back link or avatar).
- `pages/tech/JobsPage.tsx`, `pages/tech/JobDetailPage.tsx`.
- `components/JobCard.tsx`, `TicketBadges.tsx`, `PriorityReview.tsx`, `DuplicateList.tsx`, `HistoryTimeline.tsx`.
- `hooks/useAction.ts`: busy and error state for any action button.
- `services/types.ts`: types copied from `docs/api-specs/openapi.yaml`.
- `services/session.ts`: `useCurrentStaff()`.
- `services/tickets.ts`: ticket hooks and actions; `services/mockTickets.ts`: mock data.

How the mock works: no backend endpoint for these screens exists yet, so `services/tickets.ts` keeps tickets and audit events in memory (React `useSyncExternalStore`). Refreshing the page resets the data. Each hook and action has a comment naming the endpoint it stands in for, and it enforces the same rules as the spec (same team only, valid status order, proof required for DONE). Pages only call these hooks and actions, so switching to the real API means replacing the function bodies, not the pages.

Business rules the UI follows (team decisions; see "Spec changes" below):

- Acceptance is team-level: any technician on the assigned team may start and finish a job.
- A ticket has a single `priority`. `prioritySetBy` is `AI` after triage and `STAFF` once a technician confirms or changes it.
- Ticket IDs use the backend format (`tkt_` plus a hash). The UI truncates them when they do not fit.

### Endpoints needed by the Staff UI

All paths are under `/v1`. Every call sends `Authorization: Bearer <staff token>`. Errors use the spec's envelope `{ error: { code, message, requestId } }`; the UI shows `message` to the user. Status in the spec: **Spec** = already in `openapi.yaml`; **Change** = in the spec but needs the change described; **New** = proposed, not in the spec yet.

| # | Endpoint | Used by | Status in spec |
| - | -------- | ------- | -------------- |
| 1 | `POST /auth/staff/login` | Login page (not built) | Change |
| 2 | `GET /auth/staff/me` | `useCurrentStaff()` | Change |
| 3 | `GET /tickets` | `useTeamTickets()` | Change |
| 4 | `GET /tickets/{ticketId}` | `useTicket()` | Spec |
| 5 | `GET /tickets/{ticketId}/photos/{photoId}/access` | Resident photo (placeholder) | Spec |
| 6 | `PATCH /tickets/{ticketId}/status` (IN_PROGRESS) | `startWork()` | Change |
| 7 | `POST /uploads` | `uploadRepairProof()` | Spec |
| 8 | `PATCH /tickets/{ticketId}/status` (DONE) | `markDone()` | Spec |
| 9 | `PATCH /tickets/{ticketId}/priority` | `setPriority()` | Change |
| 10 | `GET /tickets/{ticketId}/duplicates` | `useDuplicateCandidates()` | New |
| 11 | `POST /tickets/{ticketId}/merge` | `mergeTickets()` | Spec |
| 12 | `GET /tickets/{ticketId}/events` | `useTicketEvents()` | Spec |

**1. `POST /auth/staff/login`**: start a staff session.

- Request: `{ email, password }`.
- Response `200`: `StaffSession` `{ accessToken, expiresInSeconds, staff: StaffProfile }`.
- Errors: `401` wrong credentials, `429` too many attempts.
- Change needed: the database draft has `account.username` and no email column. Decide whether staff log in with email or username, and use the same field in both places.

**2. `GET /auth/staff/me`**: the logged-in staff member. Replaces `MOCK_STAFF` in `session.ts`.

- Response `200`: `StaffProfile` `{ id, name, role: TECHNICIAN | MANAGER, teamId?, teamName? }`.
- Errors: `401` missing or expired token (send the user to the login page).
- Change needed: add `teamName`. The header shows the team name, and the frontend cannot turn `teamId` into a name.

**3. `GET /tickets`**: the team's jobs for the list page.

- Query: `teamId=<staff.teamId>&status=ASSIGNED&status=IN_PROGRESS` for "Team jobs"; `status=DONE` for "Completed". Also `cursor` and `limit` for paging.
- Response `200`: `TicketPage` `{ items: Ticket[], nextCursor? }`.
- Rules: the backend returns only tickets within the caller's team. The filter is a convenience, never the security check.
- Change needed: `status` accepts one value today. Allow repeated values (`style: form, explode: true`), so "Team jobs" needs one request instead of two.

**4. `GET /tickets/{ticketId}`**: one job for the detail page.

- Response `200`: `Ticket`.
- Errors: `404` when the ticket does not exist or belongs to another team (the UI shows "Job not found" for both).

**5. `GET /tickets/{ticketId}/photos/{photoId}/access`**: a short-lived URL for a photo listed in `ticket.photos`.

- Response `200`: `PhotoAccess` `{ url, expiresAt }`. Use `url` as the `<img src>`; request a new one after `expiresAt`.
- Errors: `403`, `404`.
- The resident photo is a grey placeholder until this endpoint exists.

**6. `PATCH /tickets/{ticketId}/status` with `IN_PROGRESS`**: "Start work".

- Request: `{ status: 'IN_PROGRESS' }`.
- Response `200`: the updated `Ticket`.
- Errors: `403` another team's job, `409` the job is not `ASSIGNED` (for example, already started).
- Change needed: with team-level acceptance, remove `POST /tickets/{ticketId}/accept` and the `acceptedByStaffId` and `acceptedAt` fields. Any technician on the assigned team may start the job, and the audit event records who did it.

**7. `POST /uploads`**: permission to upload the proof-of-repair photo.

- Request: `{ purpose: 'REPAIR_PROOF', contentType, sizeBytes }`.
- Response `201`: `UploadGrant` `{ uploadId, uploadUrl, method: 'PUT', headers, expiresAt }`.
- Then the browser sends the file with `PUT` to `uploadUrl`, including `headers`. Keep `uploadId` in page state; it is attached in step 8, not here.
- Errors: `422` file type or size not allowed. The allowed types and size limit are still open (SCFRMS-36).

**8. `PATCH /tickets/{ticketId}/status` with `DONE`**: "Mark as done".

- Request: `{ status: 'DONE', proofPhotoUploadId: <uploadId from step 7> }`.
- Response `200`: the updated `Ticket` with `completedAt` and a new `REPAIR_PROOF` photo.
- Errors: `403` another team's job, `409` the job is not `IN_PROGRESS`, `422` proof missing or not verified.

**9. `PATCH /tickets/{ticketId}/priority`**: "Accept LOW" and "Update" in the priority box.

- Request: `{ priority, reason? }`. "Accept" sends the current priority without a reason; "Update" sends a new priority with a reason.
- Response `200`: the updated `Ticket`, with `prioritySetBy: 'STAFF'`.
- Errors: `400` changing without a reason, `403` another team's job, `409` the job is closed.
- Change needed: remove `suggestedPriority` from `Ticket` and add `prioritySetBy: AI | STAFF` (the backend needs it anyway so AI never overwrites a staff choice). Make `reason` optional when the priority does not change.

**10. `GET /tickets/{ticketId}/duplicates`**: "Possible duplicates at this spot".

- Response `200`: `TicketPage` of open tickets visible to the caller that may describe the same problem.
- Errors: `404`.
- New endpoint: nothing in the spec finds candidates today. The mock uses "same team, same location text, still open"; the real matching rule needs team approval. Candidates are only suggestions; a technician confirms before merging.

**11. `POST /tickets/{ticketId}/merge`**: "Merge into this job". The open job is the canonical ticket and the candidate is the source.

- Header: `Idempotency-Key` (required; generate one per merge attempt and reuse it on retry).
- Request: `{ sourceTicketIds: [candidateId] }`.
- Response `200`: the canonical `Ticket`. Sources become `MERGED` with `mergedIntoTicketId`.
- Errors: `403` a ticket from another team, `409` a source is already closed, `422` invalid sources.

**12. `GET /tickets/{ticketId}/events`**: the History timeline.

- Query: `cursor`, `limit`.
- Response `200`: `TicketEventPage` `{ items: TicketEvent[], nextCursor? }` in time order.
- Note: the spec does not list event `kind` values yet. The UI maps the kinds used by the mock (`CREATED`, `TRIAGED`, `STATUS_CHANGED`, `PRIORITY_CONFIRMED`, `PRIORITY_CHANGED`, `MERGED`, `DUPLICATES_MERGED`) to text and shows any other kind as-is. The backend should agree on this list.

### Spec changes to raise with the team

Raise these in a separate PR against `docs/api-specs/openapi.yaml`:

1. Team-level acceptance: remove `/tickets/{ticketId}/accept`, `acceptedByStaffId`, `acceptedAt`; update the `/status` and `/assignment` descriptions.
2. Priority: replace `suggestedPriority` with `prioritySetBy`; make `SetPriority.reason` optional when the value does not change.
3. Add `teamName` to `StaffProfile`.
4. Allow multiple `status` values in `GET /tickets`.
5. Add `GET /tickets/{ticketId}/duplicates`.
6. Decide email or username for staff login.
7. Agree on the list of `TicketEvent.kind` values.
8. Replace the "DynamoDB" wording if the team moves to RDS.