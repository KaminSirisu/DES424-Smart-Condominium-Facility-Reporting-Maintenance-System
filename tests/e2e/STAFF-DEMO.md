# Staff repair demo with Playwright

This runs against the **deployed** staff portal and changes one real ticket from
`ASSIGNED` to `IN_PROGRESS` to `DONE`. The reporter creates the ticket manually
in LINE while a desktop screen recorder captures the whole demonstration.
Playwright starts with the team's emailed ticket link, exercises the technician
website, keeps a browser video, and lists each action as a step in its HTML
report. The final LINE completion message and its proof photo are checked
visually in the desktop recording; Playwright cannot inspect the native LINE app.

## Prepare once on your Mac

From a current checkout of this branch:

```sh
npm ci
npx playwright install chromium
npm run test:demo:staff:list
```

This headed browser test needs a graphical desktop. Run it on your Mac, not in
AWS CloudShell. Keep `playwright-report/` and `test-results/` out of Git; the
video and screenshots can contain ticket details.

## Record one live run

1. Start a desktop screen recorder. Open LINE and submit a new report with a
   realistic defect photo. Leave LINE visible for its status messages.
2. Wait for the matching team's work order email. Confirm that it contains the
   **full ticket ID** and a `/tech/jobs/<ticket-id>` link. The ticket should be
   `ASSIGNED` before starting the script. Use that team's technician account.
3. In a local **zsh** terminal, set the values below. The repair photo is a
   separate JPEG or PNG, at most 10 MiB. Enter the password privately; never
   paste it into chat, a command argument, or a tracked file.

```sh
export DEMO_TICKET_ID='tkt_REPLACE_WITH_FULL_ID'
export DEMO_PHOTO_PATH="$HOME/Downloads/repair-photo.jpg"
export STAFF_EMAIL='tech.REPLACE_WITH_TEAM.des424@gmail.com'
read -r -s 'STAFF_PASSWORD?Technician password: '; printf '\n'
export STAFF_PASSWORD
```

Optionally paste the actual link from the email. When omitted, the test builds
the same path from the ticket ID and the default staff portal origin.

```sh
export DEMO_WORK_ORDER_URL='https://d3hd1sqczt5st1.cloudfront.net/tech/jobs/tkt_REPLACE_WITH_FULL_ID'
```

4. Run the script while the desktop recorder continues:

```sh
npm run test:demo:staff
```

5. Keep recording until the reporter's LINE completion message and repair
   photo have appeared. Playwright verifies the site's `DONE` state and its
   loaded proof photo; the LINE message is a separate visual check.
6. View the step report and browser video, then clear the password from your
   shell:

```sh
npx playwright show-report playwright-report/staff-demo
unset STAFF_PASSWORD
```

The test uses no fixed sleep. It waits for the login redirect, the assigned
work order, the two status changes, and the uploaded photo. Its HTML report
shows seven named steps and a screenshot of the completed ticket. One test owns
the full stateful journey; those steps are individually visible in the report.

This test has **no automatic retry** because a failed run may already have
started or completed its ticket. If it fails after “Start work,” inspect the
ticket state before running again; use a new ticket for a clean full demo.
