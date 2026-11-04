// LIFF startup helper. Call initLiff() once when the app starts, before using
// any other liff.* method (isInClient, getProfile, getIDToken, ...).
import liff from '@line/liff';

// The two ways the app can run:
// - 'liff': connected to LINE (inside the LINE app, or logged in from a browser)
// - 'dev':  no LIFF ID configured, so LIFF is skipped for local UI work
export type LiffMode = 'liff' | 'dev';

// Lives outside the function, so it is remembered between calls.
// This makes liff.init run only once, even when React StrictMode runs
// the startup effect twice in development.
let initPromise: Promise<LiffMode> | null = null;

export function initLiff(): Promise<LiffMode> {
  // Already started: hand back the same Promise instead of starting again.
  if (initPromise) {
    return initPromise;
  }

  // Public LIFF ID from frontend/liff-app/.env (VITE_ values are visible in the browser).
  const liffId = import.meta.env.VITE_LIFF_ID;

  // No LIFF ID (undefined or ''): run in dev mode so the form still works
  // in a normal browser at http://127.0.0.1:5173.
  if (!liffId) {
    console.warn('VITE_LIFF_ID is empty, running in dev mode');
    initPromise = Promise.resolve('dev' as const);
    return initPromise;
  }

  // Connect to LINE. withLoginOnExternalBrowser sends users who open the page
  // outside the LINE app to the LINE login page first (inside LINE it does nothing).
  // init resolves with no value, so .then turns it into 'liff'.
  // Errors are not caught here on purpose: App.tsx shows them to the user.
  initPromise = liff
    .init({ liffId, withLoginOnExternalBrowser: true })
    .then(() => 'liff');
  return initPromise;
}
