import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Building2, KeyRound, Lock, Mail } from 'lucide-react';
import { api, ApiError, errorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { postLoginPath } from '../services/session';
import type { MfaEnrollment, StaffSession } from '../services/types';
import { QRCodeSVG } from 'qrcode.react';

type Step =
  | { kind: 'password' }
  | { kind: 'verify'; challengeToken: string }
  | { kind: 'enroll'; challengeToken: string; enrollment: MfaEnrollment };

/** Underlined input with an icon, like the template. */
function Field({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3 border-b border-slate-300 py-2 text-slate-700 focus-within:border-[#163469]">
      <span className="text-[#163469]">{icon}</span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full bg-transparent text-sm outline-none placeholder:text-slate-400';
const buttonClass =
  'w-full rounded-full bg-[#163469] py-3.5 text-sm font-semibold tracking-[0.2em] text-white hover:bg-[#1d4185] disabled:opacity-60';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, signIn } = useAuth();
  const requested =
    (location.state as { from?: unknown } | null)?.from ??
    new URLSearchParams(location.search).get('from');
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already logged in: go straight to this role's app.
  if (session)
    return (
      <Navigate to={postLoginPath(session.staff.role, requested)} replace />
    );

  function finish(s: StaffSession) {
    signIn(s);
    navigate(postLoginPath(s.staff.role, requested), { replace: true });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 401 &&
        step.kind !== 'password'
      ) {
        setError(
          'The code was wrong or the sign-in expired. Please try again.',
        );
      } else if (e instanceof ApiError && e.status === 401) {
        setError('Wrong email or password.');
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  function onPasswordSubmit(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      const res = await api.login(email.trim(), password);
      setPassword('');
      if ('accessToken' in res) return finish(res);
      if (res.mfaEnrolled) {
        setStep({ kind: 'verify', challengeToken: res.challengeToken });
      } else {
        const enrollment = await api.enrollMfa(res.challengeToken);
        setStep({
          kind: 'enroll',
          challengeToken: res.challengeToken,
          enrollment,
        });
      }
    });
  }

  function onCodeSubmit(e: FormEvent) {
    e.preventDefault();
    if (step.kind === 'password') return;
    run(async () => {
      const s =
        step.kind === 'verify'
          ? await api.verifyMfa(step.challengeToken, code)
          : await api.confirmMfa(step.challengeToken, code);
      setCode('');
      finish(s);
    });
  }

  function startOver() {
    setStep({ kind: 'password' });
    setCode('');
    setError(null);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4">
      <div className="mb-5 text-[#163469] flex flex-col items-center text-center">
        <Building2 size={44} className="" />
        <h1 className="text-2xl">
          Smart Condominium Facility Reporter &<br />
          Maintenance System
        </h1>
      </div>

      <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-xl shadow-slate-200/70">
        {step.kind === 'password' ? (
          <>
            <h1 className="text-3xl font-light text-slate-800">Welcome back</h1>
            <p className="mt-2 text-sm text-slate-500">
              Enter your credentials to access the juristic office dashboard.
            </p>

            <form
              onSubmit={onPasswordSubmit}
              className="mt-10 flex flex-col gap-8"
            >
              <Field icon={<Mail size={18} />}>
                <input
                  className={inputClass}
                  type="email"
                  placeholder="Enter your email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field icon={<Lock size={18} />}>
                <input
                  className={inputClass}
                  type="password"
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
              <button disabled={busy} className={buttonClass}>
                {busy ? 'SIGNING IN…' : 'SIGN IN'}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-light text-slate-800">
              {step.kind === 'verify' ? 'Verification' : 'Set up authenticator'}
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              {step.kind === 'verify'
                ? 'Enter the 6-digit code from your authenticator app.'
                : 'Open Google or Microsoft Authenticator, add an account with this key, then enter the 6-digit code it shows.'}
            </p>

            {step.kind === 'enroll' && (
              <div className="mt-6 rounded-lg bg-slate-50 p-4">
                <div className="mb-4 flex justify-center rounded-lg bg-white p-3">
                  <QRCodeSVG value={step.enrollment.otpauthUri} size={168} />
                </div>
                <p className="text-xs text-slate-500">
                  Setup key (shown only once)
                </p>
                <code className="mt-1 block break-all font-mono text-sm text-slate-900">
                  {step.enrollment.secret}
                </code>
              </div>
            )}

            <form onSubmit={onCodeSubmit} className="mt-8 flex flex-col gap-8">
              <Field icon={<KeyRound size={18} />}>
                <input
                  className={`${inputClass} tracking-widest`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123 456"
                  pattern="\s*\d{3}\s?\d{3}\s*"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoFocus
                />
              </Field>
              <button disabled={busy} className={buttonClass}>
                {busy ? 'CHECKING…' : 'VERIFY'}
              </button>
            </form>
            <button
              type="button"
              onClick={startOver}
              className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-700"
            >
              Start over
            </button>
          </>
        )}

        {error && (
          <p role="alert" className="mt-6 text-center text-sm text-red-600">
            {error}
          </p>
        )}
      </div>

      <p className="mt-10 text-sm text-[#163469]">
        Contact the manager for an account.
      </p>
    </div>
  );
}
