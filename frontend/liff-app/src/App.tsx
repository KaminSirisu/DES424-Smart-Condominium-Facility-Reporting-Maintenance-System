import { useState, useEffect } from 'react';
import ReportForm from './components/ReportForm';
import liff from '@line/liff';
import { initLiff, type LiffMode } from './utils/liff';

type LiffState =
  | { status: 'loading' }
  | { status: 'ready'; mode: LiffMode }
  | { status: 'error'; message: string };

export default function App() {
  const [liffState, setLiffState] = useState<LiffState>({ status: 'loading' });

  useEffect(() => {
    let ignore = false;

    initLiff()
      .then((mode) => {
        if (!ignore) setLiffState({ status: 'ready', mode });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!ignore) setLiffState({ status: 'error', message });
      });

    return () => {
      ignore = true;
    };
  }, []);
  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <h1 className="mb-4 text-2xl font-bold">Report a Problem</h1>
      {liffState.status === 'loading' && <p>Loading...</p>}
      {liffState.status === 'error' && (
        <p className="rounded-lg bg-red-50 p-3 text-red-800" role="alert">
          Could not connect to LINE: {liffState.message}
        </p>
      )}
      {liffState.status === 'ready' && (
        <>
          {liffState.mode === 'dev' && (
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Dev mode: LIFF is off because VITE_LIFF_ID is not set.
            </p>
          )}
          {/* import.meta.env.DEV only true when npm run dev, False in npm run build */}
          {import.meta.env.DEV && liffState.mode === 'liff' && (
            <p className="mb-4 text-xs text-slate-500">
              In LINE: {liff.isInClient() ? 'yes' : 'no'} · Logged in:{' '}
              {liff.isLoggedIn() ? 'yes' : 'no'} · OS: {liff.getOS()}
            </p>
          )}
          <ReportForm />
        </>
      )}
    </main>
  );
}
