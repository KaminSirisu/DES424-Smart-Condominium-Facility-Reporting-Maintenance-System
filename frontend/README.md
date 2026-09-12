# Frontend

Two interfaces share the same backend API but serve different users:

- `liff-app/` is the mobile reporting experience opened through LINE.
- `admin-dashboard/` is the staff portal for technicians and managers.

Keep API calls in each app's `src/services/` directory and reusable interface elements in `src/components/`. Define request/response shapes in `docs/api-specs/` before relying on them in either app. The exact React tooling has not been selected yet.
