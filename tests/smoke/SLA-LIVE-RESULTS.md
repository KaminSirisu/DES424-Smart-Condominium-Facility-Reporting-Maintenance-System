# Live SLA smoke results

These are observations from the deployed G02 dev stack in `ap-southeast-1`.
Worker execution and alert delivery are separate checks. Do not mark email
delivery passed until an SLA event and the expected recipient message are
observed. Keep credentials and message contents out of this file.

| UTC time                            | Check                                | Result  | Evidence                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-13 13:55–14:10              | EventBridge schedule and SLA worker  | PASS    | CloudWatch showed invocations at 13:55, 14:00, 14:05, and 14:10 UTC, each with `SLA sweep done`. The worker checked 1–2 tickets and recorded 0 alerts.                                                                     |
| 2026-11-13; exact time not captured | Manual synchronous Lambda invocation | PASS    | `StatusCode=200`, no `FunctionError`; response `{"checked":2,"recorded":0}`.                                                                                                                                               |
| 2026-11-13; pending                 | Due SLA event and email notification | PENDING | No alert was due in the observed runs (`recorded=0`). Wait for a disposable open ticket to cross a response, warning, or resolution threshold; then check `TicketEvents`, notification logs, and the recipient Inbox/Spam. |

Source: CloudShell output supplied by the operator on 2026-11-13. The manual
invocation is a functional check of the worker, but it does not prove the
notification path because it recorded no event.
