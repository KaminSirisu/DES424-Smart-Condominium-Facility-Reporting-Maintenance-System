# Tests

- `unit/`: ticket rules such as legal status transitions, duplicate merging, priority, and deadlines.
- `integration/`: API contracts and AWS/LINE boundary behavior using suitable test doubles or a test environment.
- `e2e/`: reporter submission and staff repair journeys through the browser.

Vitest runs from the repository root with `npm test`. For now it tests the health route. Add requirement-dependent tests when the relevant behavior is confirmed; prioritize ticket state changes, authorization, and the proof-photo requirement then.
