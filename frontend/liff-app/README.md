# LIFF reporter app

This app will let reporters select a facility zone, describe a defect, attach a photo, submit a report, view progress, and reopen an unresolved ticket. It should work well on a phone inside LINE.

Planned folders:

- `public/`: static assets.
- `src/pages/`: reporting and ticket-detail screens.
- `src/components/`: shared form and display components.
- `src/services/`: backend API calls.
- `src/utils/`: LIFF initialization and other client helpers.

The backend must verify identity tokens received from LIFF. Do not trust a user ID supplied as an ordinary form field. LINE notification delivery depends on the Messaging API recipient rules, so the reporting flow should account for the Official Account relationship.

The current app is a plain React shell. It does not initialize LIFF or make API calls.

From the repository root, run `npm ci` and then `npm run dev:liff`. The local page is at `http://127.0.0.1:5173`. Copy this folder's `.env.example` to `.env` to customize the public page title. Run `npm run build --workspace @scfrms/liff-app` to build it.
