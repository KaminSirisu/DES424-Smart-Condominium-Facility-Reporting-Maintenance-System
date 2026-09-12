# LIFF reporter app

This app will let reporters select a facility zone, describe a defect, attach a photo, submit a report, view progress, and reopen an unresolved ticket. It should work well on a phone inside LINE.

Planned folders:

- `public/`: static assets.
- `src/pages/`: reporting and ticket-detail screens.
- `src/components/`: shared form and display components.
- `src/services/`: backend API calls.
- `src/utils/`: LIFF initialization and other client helpers.

The backend must verify identity tokens received from LIFF. Do not trust a user ID supplied as an ordinary form field. LINE notification delivery depends on the Messaging API recipient rules, so the reporting flow should account for the Official Account relationship.

Add installation, local-run, build, and LIFF configuration steps after the app is initialized.
