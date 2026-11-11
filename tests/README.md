# Tests

- `unit/`: ticket rules such as legal status transitions, duplicate merging, priority, and deadlines.
- `integration/`: API contracts and AWS/LINE boundary behavior using suitable test doubles or a test environment.
- `e2e/`: reporter submission and staff repair journeys through the browser.

Vitest runs from the repository root with `npm test`.

To verify the deployed reporter intake path, use `npm run test:smoke:intake`. It requests a presigned URL, uploads a JPEG to S3, creates a ticket, and checks for `RECEIVED`. It creates a real ticket in the development account, so use a clearly labeled test location and description. The token must be a fresh LINE ID token from the same LINE Login channel configured in the dev stack. In CloudShell, read it without putting it in shell history:

```sh
read -rs LINE_ID_TOKEN
export LINE_ID_TOKEN
npm run test:smoke:intake -- ./test-photo.jpg 'Test location' 'Intake smoke test'
unset LINE_ID_TOKEN
```

Paste the token at the hidden `read` prompt and press Enter. Do not paste the token or a presigned upload URL into chat or commit it. Set `API_BASE_URL` only if testing a different stack.
