# Smart Condominium Facility Reporting & Maintenance System

A DES424 project for reporting defects in shared condominium facilities through LINE LIFF, managing repairs in a staff portal, and running the backend on AWS.

## Project status

This repository currently contains the proposed structure and documentation only. No application, infrastructure, or CI/CD workflow has been implemented yet. The project brief is the source of requirements; directory names and deployment choices here are a starting plan.

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

React build tooling, package management, AWS infrastructure tooling, and the final deployment topology still need to be chosen. Do not add setup commands here until they work in a fresh checkout.

## Team workflow

Use a short feature branch for each task, for example `feature/SCFRMS-33-report-form`, and open a pull request into the team's agreed integration branch. Keep secrets and real user data out of Git. Add a working example environment file once the first app is configured.
