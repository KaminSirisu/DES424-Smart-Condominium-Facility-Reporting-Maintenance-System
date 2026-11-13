# Remaining live API smoke checks

Run `npm run test:smoke:extended -- help` from the repository root. The script
covers M1–M9 in `RUNBOOK.md` through the deployed API; it never needs the staff
dashboard. It prompts for a password when `STAFF_PASSWORD` is absent and for a
fresh six-digit MFA code on each manager login. It does not print tokens, codes,
or the one-time password returned by account creation. `--execute` is required
for every command that changes data. Only use disposable tickets for mutations.

Until this test branch is merged, fetch it in CloudShell. After the merge, use
the latest `main` instead. The two Building Equipment reports from 2026-11-13
are a valid M1/M2 pair while both remain open and assigned:

```sh
cd ~/scfrms-g02
git remote set-branches --add origin tests/remaining-api-smoke
git fetch origin
git switch --track origin/tests/remaining-api-smoke
export STAFF_EMAIL=tech.equipment.des424@gmail.com
npm run test:smoke:extended -- inspect \
  tkt_67e89f94762b62784fdb41b383 \
  tkt_5db5d3fe73b09bf5840cadaad3
```

`inspect` checks paged audit events (M1) and that each ticket suggests the
other, never itself (M2). Expect `M1/M2 passed`. The location must be exactly
the same text, and the two tickets must have the same team and remain ASSIGNED
or IN_PROGRESS. The script is not available on older CloudShell checkouts.

The two reports were confirmed to describe the same physical machine. After
`inspect` passes, a Building Equipment technician can merge them (M5):

```sh
npm run test:smoke:extended -- merge \
  tkt_67e89f94762b62784fdb41b383 \
  tkt_5db5d3fe73b09bf5840cadaad3 --execute
```

Expect the source to become MERGED into the canonical ticket, the canonical
ticket to remain open, and a same-key retry to return 200. Merge cannot be
undone through the API. If the two reports were sent by the same LINE user,
this does not test the separate-reporter association; use another reporter's
ticket for that check.

For the other cases, make **separate disposable tickets** in LIFF. Do not use
the pair above for priority or reassignment before M2/M5. Each manager command
prompts for a current MFA code. A successfully used code cannot be reused;
wait for the authenticator to display a new one before another manager command.

| Case  | Command                                                                               | Fixture and expected result                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3    | `npm run test:smoke:extended -- priority <open-ticket-id> LOW --execute`              | Target must differ from the ticket's current priority. Checks missing-reason 400, changed priority, STAFF attribution, deadline, event, and retry.                         |
| M4    | `npm run test:smoke:extended -- assignment <assigned-ticket-id> ELECTRICAL --execute` | Manager only; target team must differ and exist. Checks missing-reason 400, moved team, preserved category, and event.                                                     |
| M6    | `npm run test:smoke:extended -- dashboard <known-ticket-id>`                          | Manager only; checks summary and paged history include the ticket.                                                                                                         |
| M7–M8 | `npm run test:smoke:extended -- accounts <new-test-email> --execute`                  | Manager only; creates a test manager, checks the one-time password exists, immediately deactivates it, and checks the safe account list. Use a unique address you control. |
| M9    | `npm run test:smoke:extended -- triage <ticket-id> PLUMBING LOW --execute`            | Manager only. A genuine RECEIVED ticket is manually assigned and audited. An already ASSIGNED ticket checks the expected 409 guard and reports the success path pending.   |

The SLA worker is not an HTTP route and is tested separately: verify the
five-minute schedule invokes the sweep, then observe the appropriate SES
warning or breach email when a disposable ticket actually reaches a threshold.
The reset invalidated every earlier ticket ID; keep pre-reset evidence as
historical results and record new IDs for this pass.
