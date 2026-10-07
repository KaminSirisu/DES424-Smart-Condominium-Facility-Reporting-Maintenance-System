# LIFF reporter app

Residents open this app from the "Report a Problem" button in the LINE Official Account rich menu. They take or choose a photo of a broken shared facility, describe the problem, and submit a report. Category, priority, and the assigned team are decided later by the backend, so the form only asks for a photo and a description.

The app uses React, TypeScript, Vite, Tailwind CSS, and the LINE LIFF SDK. It is built for phones inside LINE.

## Current status

- LIFF starts on load. Users who open the page outside the LINE app are sent to LINE Login first.
- The report form checks that a photo (image file, up to 10 MB) and a description (10–500 characters) are present.
- Submitting does not reach a backend yet. `submitReport` in `src/services/api.ts` only logs the data and waits one second. It will later upload the photo to S3 and create the report through API Gateway and Lambda.

## Folders

- `public/`: files served as-is at a fixed URL.
- `src/assets/`: images imported by components. Vite adds a content hash to their file names when building.
- `src/components/`: `ImageUpload`, `ReportForm`, and `SubmitButton`.
- `src/pages/`: future screens, such as ticket status.
- `src/services/`: backend API calls.
- `src/utils/`: LIFF initialization.

## Configuration

Copy `.env.example` to `.env` in this folder and set `VITE_LIFF_ID` to the LIFF ID from the LINE Developers Console (LINE Login channel → LIFF tab). It looks like `1234567890-AbCdEfGh`. Restart the dev server after changing `.env`.

Every `VITE_` value is visible in the browser. Only the LIFF ID belongs here. Never put the Channel Secret, Channel Access Token, or AWS credentials in this app.

The backend must verify the ID token received from LIFF. Do not trust a user ID supplied as an ordinary form field. LINE notification delivery depends on the Messaging API recipient rules, so the reporting flow should account for the Official Account relationship.

## Local development

From the repository root, run `npm ci` and then `npm run dev:liff`. The local page is at `http://127.0.0.1:5173`.

Leave `VITE_LIFF_ID` empty to work on the interface in a normal browser. The app then skips LIFF and shows a "Dev mode" banner. With a real LIFF ID, LINE Login only redirects back to the registered Endpoint URL, so use the ngrok setup below instead of `127.0.0.1`.

Run `npm run build --workspace @scfrms/liff-app` to type-check and build the app.

## Testing inside LINE

1. Start the dev server with `npm run dev:liff`.
2. In another terminal, run `ngrok http 127.0.0.1:5173 --url=https://<your-domain>.ngrok-free.dev`. Use the full address `127.0.0.1`, because the dev server does not listen on IPv6.
3. In the LINE Developers Console, set the LIFF app's Endpoint URL to your ngrok URL.
4. Send `https://liff.line.me/<LIFF ID>` to yourself in a LINE chat and open it on your phone.

`vite.config.ts` allows `*.ngrok-free.dev` hosts. If your ngrok domain ends differently, add it to `server.allowedHosts`. While the dev server runs, a small line under the heading shows whether the page is inside LINE, the login state, and the OS.

## Credits

- Camera icon by [good-ware](https://www.flaticon.com/authors/good-ware) from [Flaticon](https://www.flaticon.com/free-icon/camera_685655)
- Check icon by [hqrloveq](https://www.flaticon.com/authors/hqrloveq) from [Flaticon](https://www.flaticon.com/free-icon/check_14090371)
