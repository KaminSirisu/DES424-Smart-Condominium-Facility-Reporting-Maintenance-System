# Staff portal

This app will provide email/password login, technician task views, and manager views. Planned actions include accepting or changing priority, moving a ticket through its allowed statuses, uploading repair proof, merging duplicates, and viewing deadlines and historical reports.

Planned folders:

- `src/pages/`: login, technician, and manager screens.
- `src/components/`: shared ticket and dashboard components.
- `src/services/`: API calls and session handling.

The backend, not just the UI, must authorize technician and manager actions. A `Dockerfile` should be added when the app has a real build and serving command. The container can then be deployed on ECS Fargate if the team pursues the course bonus.
