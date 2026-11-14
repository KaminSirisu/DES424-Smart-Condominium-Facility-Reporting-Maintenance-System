# M1–M9 live API runbook

Run these commands in **CloudShell**, from `~/scfrms-g02`. They call the deployed
API directly; the staff dashboard does not need to be finished. The script
prompts for the staff password and, for a manager, a fresh six-digit MFA code.
It does not print tokens or passwords. Every command writes a timestamped
PASS, FAIL, or GUARD_PASS record to `~/scfrms-smoke-results.jsonl` (or the path
set in `SCFRMS_SMOKE_LOG`). The shared record is
[`LIVE-RESULTS.md`](LIVE-RESULTS.md). Copy only reviewed, safe results there.

## 0. Prepare CloudShell

Check that the current branch is `tests/remaining-api-smoke`, then refresh it:

```sh
cd ~/scfrms-g02
git status --short --branch
git pull --ff-only
git log -1 --oneline
export API_BASE_URL='https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com/v1'
unset STAFF_PASSWORD
```

If CloudShell is still on another branch, fetch and switch first:

```sh
git remote set-branches --add origin tests/remaining-api-smoke
git fetch origin
git switch --track origin/tests/remaining-api-smoke
```

Run `npm run test:smoke:extended -- help` to see all modes. A manager's MFA code
can only be used once; wait for a new code before the next manager command.
Keep `STAFF_PASSWORD` unset so the script asks for it privately. No LINE token
is needed for these staff API checks.

## 1. M1/M2: history and duplicate suggestions — PASS

The operator already observed `M1/M2 passed` for these open Building Equipment
tickets at the exact location `Fitness Facility`, confirmed to describe the
same physical machine:

| Role      | Ticket ID                        |
| --------- | -------------------------------- |
| Canonical | `tkt_67e89f94762b62784fdb41b383` |
| Source    | `tkt_5db5d3fe73b09bf5840cadaad3` |

This result is recorded in `LIVE-RESULTS.md`. If the local JSONL file does not
exist yet, rerun the **read-only** command before M5 to create timestamped
entries:

```sh
export STAFF_EMAIL=tech.equipment.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- inspect \
  tkt_67e89f94762b62784fdb41b383 \
  tkt_5db5d3fe73b09bf5840cadaad3
```

Expected: `M1/M2 passed: history readable; ... suggest each other.` The script
checks paged, ordered audit events, reciprocal suggestions, and no self-match.
Do this before merging; a merged source is no longer an open candidate.

## 2. M5: merge the confirmed pair

Use the Building Equipment technician. This changes the source to `MERGED`
and cannot be undone through the API. The script checks both tickets are still
open and assigned to the technician's team before it sends the merge.

```sh
export STAFF_EMAIL=tech.equipment.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- merge \
  tkt_67e89f94762b62784fdb41b383 \
  tkt_5db5d3fe73b09bf5840cadaad3 --execute
```

Expected: `M5 passed: <source> merged into <canonical>; same-key retry returned
200.` The canonical remains open, the source points to it, and the script
retries with the same idempotency key. Run this command **once**; a new run
would find the source already merged. If both reports came from one LINE user,
this does not cover linking two reporters to the canonical ticket.

## 3. M3: change priority on a different disposable ticket

Create a new report through LIFF and wait for `ASSIGNED`. Use an own-team
technician or the manager. Enter an ID for a ticket with current priority
`MEDIUM` if you plan to change it to `LOW`; otherwise choose a different
target from `CRITICAL`, `MEDIUM`, or `LOW`.

```sh
read -r -p 'M3 assigned ticket ID: ' M3_TICKET_ID
export STAFF_EMAIL=tech.equipment.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- priority "$M3_TICKET_ID" LOW --execute
```

Expected: `M3 passed: <id> priority MEDIUM -> LOW; retry remained LOW.` The
script first checks that a change without a reason returns HTTP 400, then
checks `prioritySetBy=STAFF`, a deadline, a `PRIORITY_CHANGED` event, and an
idempotent retry. If the target equals the current priority, the preflight
stops without changing anything. A different-team technician gets HTTP 403.

## 4. M4: reassign another disposable ticket

Create a **separate** LIFF ticket and wait for `ASSIGNED`. It must not already
belong to `ELECTRICAL`, and work must not have started. Use the manager.

```sh
read -r -p 'M4 assigned ticket ID: ' M4_TICKET_ID
export STAFF_EMAIL=manager.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- assignment "$M4_TICKET_ID" ELECTRICAL --execute
```

Expected: `M4 passed: <id> reassigned <old-team> -> ELECTRICAL; category
preserved.` The script checks missing-reason HTTP 400, the changed team, the
unchanged category, and a `REASSIGNED` event. It prompts for the manager
password and a current MFA code. A ticket already `IN_PROGRESS` should return
HTTP 409; use another fixture instead of resetting its state.

## 5. M6: manager dashboard history — wait for the IAM deploy

The dashboard history Lambda needs the `TicketPhotos` read grant in draft PR
#16 to be **merged and deployed**. The API call may return HTTP 500 until that
CDK change reaches AWS. After deployment, use any known ticket still in the
dashboard's date window, for example the canonical ticket:

```sh
export STAFF_EMAIL=manager.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- dashboard tkt_67e89f94762b62784fdb41b383
```

Expected: `M6 passed: dashboard summary and history include <id>.` This checks
summary counts and filtered, paged history. Do not record a PASS before a live
run. If it returns HTTP 500 before the IAM deploy, mark M6 **BLOCKED**.

## 6. M7/M8: create and immediately deactivate a test manager

Choose a unique test email address you control. It does not need SES
verification for this account-management check. The script confirms the API
returned a one-time password but does not print or save that password.

```sh
read -r -p 'Unique test manager email: ' TEST_MANAGER_EMAIL
export STAFF_EMAIL=manager.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- accounts "$TEST_MANAGER_EMAIL" --execute
```

Expected: `M7/M8 passed: test manager <id> created and deactivated.` M7 checks
HTTP 201 and the account response. M8 checks `isActive=false` and that the
account list excludes stored secrets. If a later assertion fails after account
creation, the script attempts to deactivate the account in `finally`; follow
any `Cleanup needed` message before continuing.

## 7. M9: manual triage guard, then success only with a RECEIVED ticket

The M4 ticket, if still `ASSIGNED`, can check that manual triage refuses an
already assigned ticket. Use a different team from its new `ELECTRICAL` team:

```sh
export STAFF_EMAIL=manager.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- triage "$M4_TICKET_ID" PLUMBING LOW --execute
```

Expected: `M9 guard passed: ... returned 409` and a `GUARD_PASS` log entry.
This does **not** prove the successful manual triage path. To test that path,
use a genuine ticket still in `RECEIVED` and run the same command with its ID:

```sh
read -r -p 'Genuine RECEIVED ticket ID: ' RECEIVED_TICKET_ID
export STAFF_EMAIL=manager.des424@gmail.com
unset STAFF_PASSWORD
npm run test:smoke:extended -- triage "$RECEIVED_TICKET_ID" PLUMBING LOW --execute
```

Expected: `M9 passed: <id> manually triaged to PLUMBING/LOW.` AI triage
normally assigns new tickets quickly, so a normal LIFF submission may be
`ASSIGNED` before this runs. If no genuine `RECEIVED` fixture exists, record
the success path as **BLOCKED**, not PASS. Do not turn off the stream or edit
DynamoDB just to force this test.

## 8. Review results and finish

```sh
tail -n 20 "$HOME/scfrms-smoke-results.jsonl"
unset STAFF_PASSWORD STAFF_EMAIL
```

For each run, copy the case, UTC time, fixture ID, PASS/FAIL/GUARD_PASS, and
short redacted output into `LIVE-RESULTS.md`. A failure should stay in the
record even after a later retry passes. HTTP 401 usually means stale/wrong
credentials or MFA; HTTP 403 means wrong role/team; HTTP 404 often means a
wrong ticket ID; HTTP 409 means the ticket changed state; HTTP 500 needs the
corresponding Lambda log. Do not paste tokens, passwords, MFA codes, or signed
URLs into the evidence file or chat.

The SLA sweep is a separate asynchronous check: confirm the five-minute
schedule invokes it, then observe the SES warning or breach email when a
disposable ticket actually reaches a threshold.
