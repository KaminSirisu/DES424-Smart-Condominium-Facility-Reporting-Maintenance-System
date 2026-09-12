# Database design

Document DynamoDB tables, partition/sort keys, indexes, and access patterns before implementing data helpers. Include tickets, facility zones, staff accounts and roles, reporter-to-ticket associations, deadlines, and status audit events.

Define how merged tickets retain reporter associations, how reopening affects deadlines, and how managers query historical data.

## Staff account record — draft for team review

The team's original example has the core information needed for a technician. The only edit below is removing the backslash before `@` so the example is valid JSON:

```json
{
  "email": "plumbing@condocare.com",
  "passwordHash": "$2b$10$...",
  "name": "Somchai (Plumbing)",
  "role": "TECHNICIAN",
  "team": "Plumbing Team"
}
```

Proposed revision:

```json
{
  "email": "plumbing@condocare.com",
  "staffId": "staff_001",
  "passwordHash": "$argon2id$...",
  "name": "Somchai",
  "role": "TECHNICIAN",
  "teamId": "PLUMBING",
  "status": "ACTIVE",
  "createdAt": "2026-09-12T10:00:00Z",
  "updatedAt": "2026-09-12T10:00:00Z"
}
```

For a simple dedicated `Staff` table, use normalized lowercase `email` as the partition key for direct login lookup and unique email addresses. Keep `staffId` as a separate, stable identifier for ticket assignments. Changing an email would require moving the staff item to a new key while preserving `staffId`; decide that flow before implementation. `teamId` is a consistent code for filtering and assignment, while a display name such as “Plumbing Team” can be defined separately. `status` allows an account to be disabled without deleting its repair history.

Store only a password hash, never a plaintext password. The original `$2b$10$...` placeholder represents bcrypt; the proposed `$argon2id$...` represents Argon2id. Choose and document one algorithm before creating real staff accounts. JWTs are issued at login and verified by protected endpoints; they are not staff-record fields and do not need to be stored here. Never return `passwordHash` in API responses.

Team decisions still open: exact role and team codes, whether email changes are supported, the password-hash algorithm, and whether disabling an account must invalidate an already issued JWT immediately.
