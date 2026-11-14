# Staff portal

This app has two parts that share one login: the juristic office (manager) dashboard and the technician Staff UI. Both run on the deployed dev API. A manager logs in with a password and an authenticator code and lands on `/`; a technician logs in with a password only and lands on `/tech`.

From the repository root, run `npm ci` and then `npm run dev:admin`; the local page is at `http://127.0.0.1:5174`. In development, requests go to `/api`, and the Vite proxy forwards them to the API (see `vite.config.ts`), so no CORS change is needed. Copy this folder's `.env.example` to `.env` to customize it. Run `npm run build --workspace @scfrms/admin-dashboard` to build it.

The backend, not just the UI, must authorize technician and manager actions. A `Dockerfile` should be added when the app has a real build and serving command. The container can then be deployed on ECS Fargate if the team pursues the course bonus.

## Admin dashboard

### Route map

| Route                | Page           | What it shows                                                                                                                                                                                                     | API calls                                                                         |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/login`             | `LoginPage`    | Email and password, then the 6-digit authenticator code (or first-time authenticator setup). A technician skips the code step and goes to `/tech`. There is no signup; accounts are created by the administrator. | `POST /auth/staff/login`, `/auth/staff/mfa/verify`, `/mfa/enroll`, `/mfa/confirm` |
| `/`                  | `OverviewPage` | Count cards, open tickets with filters (All open, Assigned, In progress, Overdue) and search, SLA breaches, team workload, CSV export.                                                                            | `GET /dashboard/summary`, `GET /dashboard/history`                                |
| `/triage`            | `TriagePage`   | Reports the AI could not classify (still `RECEIVED`, no team). The manager chooses the team and priority.                                                                                                         | `GET /tickets?status=RECEIVED`, `PATCH /tickets/{id}/triage`                      |
| `/tickets`           | `TicketsPage`  | Every ticket (open first, then done, then merged), search, CSV export.                                                                                                                                            | `GET /dashboard/history`                                                          |
| `/tickets/:ticketId` | `TicketsPage`  | Opens the specified ticket in the detail drawer, including when reached from a manager email.                                                                                                                     | `GET /tickets/{id}`, `GET /tickets/{id}/events`                                   |
| `/staff`             | `StaffPage`    | Per-team assigned / in progress / overdue / completed counts and the staff account list (read-only).                                                                                                              | `GET /dashboard/summary`, `GET /dashboard/history`, `GET /staff-accounts`         |
| `/history`           | `HistoryPage`  | Closed jobs, % that met the SLA, average fix time, breakdown by location, CSV export.                                                                                                                             | `GET /dashboard/history`                                                          |
| `/settings`          | `SettingsPage` | The SLA policy by priority and the teams. Read-only: the SLA is fixed in the backend.                                                                                                                             | none                                                                              |

Clicking a ticket on Overview or All tickets opens `TicketDrawer`. It shows the photo, who set the priority (AI, Technician or Manager) and the activity log. While the ticket is `ASSIGNED` or `IN_PROGRESS`, the manager can change the priority; while it is `ASSIGNED`, the manager can move it to another team. A reason is required for every change.
(`GET /tickets/{id}`, `GET /tickets/{id}/events`, `GET /tickets/{id}/photos/{photoId}/access`, `PATCH /tickets/{id}/priority`, `PATCH /tickets/{id}/assignment`)

### How it works

- `App.tsx` defines the routes. `/login` is outside the layout. Every other page is a child of `AdminLayout`, which renders the sidebar once and the page in `<Outlet />`.
- `AdminLayout` is the login guard: without a session it redirects to `/login`, and a technician is sent to `/tech`.
- `AuthContext` shares the session with the components. `services/session.ts` keeps it in `sessionStorage`, so a refresh keeps the manager logged in and closing the tab logs them out.
- A ticket link from email returns to the ticket after login. Managers use `/tickets/:ticketId`; technicians use `/tech/jobs/:ticketId`. The URL always contains the full ticket ID, and the backend still enforces role and team access.
- `services/api.ts` holds all API calls. It adds the token, turns error responses into `ApiError`, and on a 401 clears the session and returns to `/login`.
- `hooks/useApi.ts` loads data for a page (skeleton while loading, error with Retry, `reload()` after a save). `hooks/useNow.ts` updates the SLA countdown every minute.
- The team names and the SLA hours shown in Settings are in `lib/constants.ts`. The SLA hours are a display copy of `backend/src/triage/policy.ts`, so change both together.

### Folders

- `src/pages/`: one file per route; `src/pages/tech/` holds the Staff UI pages.
- `src/components/`: Sidebar, TicketTable, TicketDrawer, badges, stat cards, skeletons, and the Staff UI parts (TechHeader, JobCard, PriorityReview, DuplicateList, HistoryTimeline). PhotoPreview is shared.
- `src/context/`: AuthContext.
- `src/services/`: API types, API calls and session storage.
- `src/hooks/`: useApi, useNow, and useAction (busy and error state for an action button).
- `src/lib/`: constants, formatting, event labels (shared by both parts), CSV export and ticket search.

### How to add a page

Create the page in `src/pages/`, add a child route in `App.tsx`, and add an item to `navItems` in `components/Sidebar.tsx`.

### Not done yet

- Deployment: set `VITE_API_BASE_URL` to the API URL including `/v1`, and add the deployed admin URL as the `adminOrigin` CDK context so API Gateway allows it (CORS).

## Staff UI

Mobile screens for technicians. Every technician of a team shares one account, so the header shows the team name. It is a separate top-level route with its own phone-width layout, so the admin sidebar never appears.

### Route map

| Route                  | Page               | What it shows                                                                                                                                                                        | API calls                                                                     |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `/tech`                | `JobsPage`         | "Team jobs" (`ASSIGNED` and `IN_PROGRESS`, oldest first) and "Completed" (`DONE`) tabs, with the SLA countdown. The tab is kept in the URL (`?tab=completed`) so Back returns to it. | `GET /tickets?status=ASSIGNED&status=IN_PROGRESS`, `GET /tickets?status=DONE` |
| `/tech/jobs/:ticketId` | `JobDetailPage`    | Resident's photo, Start work, proof-of-repair upload, Mark as done, priority review, possible duplicates and history.                                                                | See below                                                                     |
| `/tech/*`              | `TechNotFoundPage` | Technician 404 page.                                                                                                                                                                 | none                                                                          |

Job detail calls:

- Load: `GET /tickets/{id}`, `GET /tickets/{id}/events`, `GET /tickets/{id}/duplicates`, `GET /tickets/{id}/photos/{photoId}/access`.
- Start work: `PATCH /tickets/{id}/status` with `IN_PROGRESS`.
- Proof photo: `POST /uploads` with `REPAIR_PROOF`, then a `PUT` of the file to the returned S3 URL. JPEG or PNG, at most 10 MB; the app checks this before uploading.
- Mark as done: `PATCH /tickets/{id}/status` with `DONE` and the `proofPhotoUploadId`.
- Priority: `PATCH /tickets/{id}/priority`. Accept sends the current priority without a reason; Update needs a reason.
- Merge: `POST /tickets/{id}/merge` with an `Idempotency-Key` header. The open job is the canonical ticket and the candidate is the source.

### How it works

- `TechLayout` is the guard: without a session it redirects to `/login`, and a manager is sent to `/` (only technicians may upload proof and merge).
- `JobDetailPage` loads the ticket, history and duplicates in parallel. After any action it bumps one `version` counter, which reloads all three, so the screen always shows the server's state.
- Each action button uses `useAction` for its busy state and error message, so a double tap cannot send a request twice.

### Not done yet

- Uploading from `http://127.0.0.1:5174` needs the photo bucket's CORS to allow that origin. If the upload fails with a CORS error in the browser console, the backend team has to add it.
