# Tests

- `unit/`: ticket rules such as legal status transitions, duplicate merging, priority, and deadlines.
- `integration/`: API contracts and AWS/LINE boundary behavior using suitable test doubles or a test environment.
- `e2e/`: reporter submission and staff repair journeys through the browser.
- `smoke/`: live checks of the deployed development endpoint.

Vitest runs from the repository root with `npm test` and covers the backend and infrastructure logic without AWS credentials. After a deployment, run the live health and LIFF CORS check:

```sh
npm run test:smoke -- https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1
```

This test needs only network access. Ticket submission and triage smoke checks can be added once `POST /uploads`, LINE Login configuration, and the Bedrock model are ready.
