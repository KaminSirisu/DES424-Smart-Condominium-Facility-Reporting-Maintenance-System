# Backend

TypeScript/JavaScript Lambda code lives under `src/`:

- `handlers/`: HTTP routes and scheduled-event entry points.
- `auth/`: staff login, password verification, JWT verification, and role checks.
- `tickets/`: ticket creation, state transitions, merging, reopening, deadlines, and audit records.
- `shared/`: DynamoDB, S3, LINE, and other service clients.

Initial API capabilities to design include staff login; ticket creation, listing, detail, status update, reopen, and merge; photo upload authorization; dashboard summaries; and LINE notifications. SLA escalation and AI triage need event handlers. This is a capability list, not a commitment to one Lambda per endpoint.

Store staff records and password hashes in DynamoDB. The original and proposed staff records, key choice, and open team decisions are documented in [`docs/database/README.md`](../docs/database/README.md#staff-account-record--draft-for-team-review). Sign short-lived JWTs with a protected key or secret and verify the token and staff role on every protected request. Do not store plaintext passwords or commit signing secrets.

Document request/response contracts in `docs/api-specs/` and ticket data/access patterns in `docs/database/` before implementation spreads across handlers.

The current backend contains only a dependency-free health route. From the repository root, run `npm ci`, copy `.env.example` to `.env`, and start it with `npm run dev:backend`. `curl http://127.0.0.1:3000/health` returns `{"status":"ok"}`. `BACKEND_PORT` in the root `.env` changes the local port. The Lambda entry point is `src/handlers/health.ts`; AWS routing and deployment remain unconfigured.
