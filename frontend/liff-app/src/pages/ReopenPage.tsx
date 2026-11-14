import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { MapPin, RotateCcw } from 'lucide-react';
import check from '../assets/check.png';
import ErrorBox from '../components/ErrorBox';
import PageHeader from '../components/PageHeader';
import PhotoPreview from '../components/PhotoPreview';
import { TicketSkeleton } from '../components/Skeleton';
import { useAsync } from '../hooks/useAsync';
import {
  canReopen,
  formatDateTime,
  latestProofPhoto,
  reopenDeadline,
  shortId,
  STATUS_LABEL,
  teamLabel,
} from '../lib/format';
import { navigate, ticketPath } from '../lib/router';
import {
  apiErrorMessage,
  getTicket,
  REOPEN_REASON_MAX,
  reopenTicket,
  type Ticket,
} from '../services/api';

// Opened by "Re-open" in the LINE message (POST /tickets/{id}/reopen).
export default function ReopenPage({ ticketId }: { ticketId: string }) {
  const ticket = useAsync(() => getTicket(ticketId), ticketId);

  return (
    <div>
      <PageHeader
        title="Re-open report"
        subtitle={shortId(ticketId)}
        backTo={ticketPath(ticketId)}
      />
      <div className="flex flex-col gap-5 p-4">
        {ticket.data ? (
          <ReopenForm t={ticket.data} />
        ) : ticket.error ? (
          <ErrorBox message={ticket.error} onRetry={ticket.reload} />
        ) : (
          <TicketSkeleton />
        )}
      </div>
    </div>
  );
}

function ReopenForm({ t }: { t: Ticket }) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reopened, setReopened] = useState<Ticket | null>(null);
  // One key for this page: pressing the button again after an error is a retry
  // of the same request, so the backend never reopens the ticket twice.
  const keyRef = useRef(crypto.randomUUID());

  if (reopened) return <Reopened t={reopened} />;

  // Only a finished repair, at most 7 days old, can be re-opened.
  if (t.status !== 'DONE') {
    return (
      <Notice>
        This report is <strong>{STATUS_LABEL[t.status]}</strong>. Only a
        finished repair can be re-opened.
        <ViewReportButton ticketId={t.id} />
      </Notice>
    );
  }
  if (!canReopen(t)) {
    return (
      <Notice>
        More than 7 days have passed since this repair, so it can no longer be
        re-opened. If the problem is back, please send a new report.
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-3 w-full rounded-lg bg-[#06C755] py-3 font-semibold text-white"
        >
          Send a new report
        </button>
      </Notice>
    );
  }

  const proof = latestProofPhoto(t);
  const deadline = reopenDeadline(t);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setReopened(await reopenTicket(t.id, reason, keyRef.current));
    } catch (err) {
      console.error('Error re-opening report:', err);
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <section>
        <h2 className="text-base font-semibold">{t.description}</h2>
        <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
          <MapPin size={12} className="shrink-0" />
          {t.location}
        </p>
        {t.completedAt && (
          <p className="mt-1 text-xs text-gray-500">
            Repaired on {formatDateTime(t.completedAt)}
          </p>
        )}
      </section>

      {proof && (
        <section>
          <h3 className="mb-1 text-xs text-gray-500">Repair photo</h3>
          <PhotoPreview
            ticketId={t.id}
            photoId={proof.id}
            alt="Photo of the repair"
          />
        </section>
      )}

      <div>
        <label htmlFor={reasonId} className="mb-1 block text-sm font-medium">
          What is still wrong?{' '}
          <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REOPEN_REASON_MAX}
          rows={4}
          placeholder="e.g. The toilet still leaks after flushing"
          className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base placeholder:text-sm focus:border-[#06C755] focus:outline-none"
        />
        <p className="mt-1 text-right text-xs text-slate-500">
          {reason.length}/{REOPEN_REASON_MAX}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-lg bg-orange-600 py-3 font-semibold text-white active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RotateCcw size={16} />
          {busy ? 'Re-opening…' : 'Re-open report'}
        </button>
        {deadline && (
          <p className="text-center text-xs text-gray-500">
            The team will be asked to fix it again. You can re-open until{' '}
            {formatDateTime(deadline.toISOString())}.
          </p>
        )}
      </div>
    </form>
  );
}

function Reopened({ t }: { t: Ticket }) {
  const team = teamLabel(t.teamId);
  return (
    <div className="space-y-4 rounded-lg bg-white p-6 text-center">
      <img
        src={check}
        alt=""
        aria-hidden="true"
        className="mx-auto h-15 w-15"
      />
      <p className="font-semibold">Report re-opened</p>
      <p className="text-sm text-slate-600">
        {team ? `The ${team} team` : 'Our maintenance team'} will take another
        look. We will message you in LINE when it is fixed.
      </p>
      <ViewReportButton ticketId={t.id} />
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
      {children}
    </div>
  );
}

function ViewReportButton({ ticketId }: { ticketId: string }) {
  return (
    <button
      type="button"
      onClick={() => navigate(ticketPath(ticketId))}
      className="mt-3 w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium"
    >
      View report
    </button>
  );
}
