# Live extended API results

Only record results observed against the deployed API. Keep tokens, passwords,
MFA codes, signed URLs, and full authentication responses out of this file.
The exact CloudShell run time and checkout commit were not captured for the
first two rows; the date and result came from the operator's reported output.

| Date (UTC time if captured)   | Case                      | Fixture                                                            | Result | Evidence                                                                                       |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------- |
| 2026-11-13; time not captured | M1, ticket history        | `tkt_67e89f94762b62784fdb41b383`                                   | PASS   | `M1/M2 passed: history readable; ...` The script checked paged events and chronological order. |
| 2026-11-13; time not captured | M2, duplicate suggestions | `tkt_67e89f94762b62784fdb41b383`, `tkt_5db5d3fe73b09bf5840cadaad3` | PASS   | The same output reported that the two tickets suggest each other.                              |

Source: CloudShell output pasted by the operator in chat on 2026-11-13. The
script was run from the `tests/remaining-api-smoke` branch; its exact checkout
commit was not supplied. Future runs of `extended-api.mjs` append timestamped
JSON lines to `~/scfrms-smoke-results.jsonl` in CloudShell. Review and copy
safe results here after each run. If a test fails, preserve its failure row and
add a new PASS row after the fix.
