# Smart Condominium Facility Reporting & Maintenance System

A DES424 project for reporting defects in shared condominium facilities through LINE LIFF, managing repairs in a staff portal, and running the backend on AWS.

## Project status

This repository has requirement-independent development shells for both frontends and the backend, plus local checks and CI. Business flows, AWS infrastructure, and deployment are not implemented. The project brief and later decisions under `docs/` govern requirements; directory names and deployment choices here remain a starting plan.

## Local development

Use Node.js 22.12 or newer and npm. Node 22 is recorded in `.nvmrc` and used by CI.

```sh
npm ci
cp .env.example .env
cp frontend/liff-app/.env.example frontend/liff-app/.env
cp frontend/admin-dashboard/.env.example frontend/admin-dashboard/.env
```

Run each service in a separate terminal:

```sh
npm run dev:liff       # http://127.0.0.1:5173
npm run dev:admin      # http://127.0.0.1:5174
npm run dev:backend    # http://127.0.0.1:3000/health
```

The backend serves only `GET /health` locally. The Lambda handler for that route is in `backend/src/handlers/health.ts`. The frontend pages are placeholders and do not call an API or initialize LIFF.
If a frontend port is already in use, Vite prints the alternate port it selected.

Run all local checks before opening a pull request:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Use `npm run format` to apply formatting. The GitHub Actions workflow runs the same checks on pushes and pull requests. It does not deploy anything. Environment files other than examples are ignored by Git; `VITE_` values are public in browser bundles and must not contain secrets.

## Planned structure

```text
frontend/
  liff-app/             Resident and visitor reporting interface
  admin-dashboard/      Technician and manager portal
backend/
  src/handlers/         API and scheduled-event entry points
  src/auth/             Staff login, JWT checks, and role checks
  src/tickets/          Ticket lifecycle and business rules
  src/shared/           AWS and LINE client helpers
infrastructure/
  aws/                  AWS infrastructure definitions
  docker/               Local container configuration
tests/
  unit/                 Business-logic tests
  integration/          API and service integration tests
  e2e/                  Reporter and staff journeys
docs/
  architecture/         System and sequence diagrams
  api-specs/            API contract
  database/             Data model and access patterns
  reports/              Course deliverables
.github/workflows/       CI/CD workflows when implemented
```

Each app and major area has its own README describing its responsibilities. Empty source folders contain `.gitkeep` so the intended structure is visible in Git.

## Intended user journeys

1. A reporter opens the LIFF app, selects a facility zone, describes the issue, and uploads a photo without creating a separate account.
2. The backend creates a ticket, suggests category and priority, sets a deadline, and sends a submission receipt.
3. Staff sign in with email and password, review tickets, adjust priority, update status, and upload repair proof before completion.
4. Reporters receive status updates and can reopen an unresolved ticket. Managers see ticket counts, overdue work, and repair history.

The API design must also cover duplicate-ticket merging, supervisor escalations, authorization, and an audit trail of status changes.

## Technology decisions

- Backend: TypeScript/JavaScript on AWS Lambda, with API Gateway, DynamoDB, and S3.
- Reporter interface: LINE LIFF with a React-based frontend.
- Staff portal: React-based frontend; Docker/ECS Fargate is a bonus deployment target, while deployment to AWS is required.
- Staff identity: accounts and password hashes in DynamoDB; login issues signed, expiring JWTs. Staff roles are enforced by backend endpoints.

The development baseline uses npm workspaces, Vite, TypeScript, ESLint, Prettier, and Vitest. AWS infrastructure tooling and the final deployment topology still need to be chosen.

## Team workflow

Use a short feature branch for each task, for example `feature/SCFRMS-33-report-form`, and open a pull request into the team's agreed integration branch. Keep secrets and real user data out of Git. Add a working example environment file once the first app is configured.
