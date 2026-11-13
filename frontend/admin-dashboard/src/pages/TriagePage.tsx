import { useState } from 'react';
import { MapPin } from 'lucide-react';
import { api, ApiError, errorMessage } from '../services/api';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import LoadState from '../components/LoadState';
import { CardListSkeleton } from '../components/Skeleton';
import { PRIORITIES, SLA_POLICY, TEAMS } from '../lib/constants';
import { formatDateTime, formatDuration, shortId } from '../lib/format';
import type { Priority, Ticket } from '../services/types';

const field =
  'rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50';

function TriageRow({
  ticket,
  now,
  onDone,
}: {
  ticket: Ticket;
  now: number;
  onDone: () => void;
}) {
  const [teamId, setTeamId] = useState('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign() {
    if (!teamId || !priority) {
      setError('Choose a team and a priority.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.triage(ticket.id, teamId, priority, reason.trim() || undefined);
      onDone();
    } catch (e) {
      // 409: no longer RECEIVED (the AI just triaged it). Just refresh.
      if (e instanceof ApiError && e.status === 409) onDone();
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-bold">{shortId(ticket.id)}</p>
          <p className="mt-1">{ticket.description}</p>
          <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
            <MapPin size={12} className="text-red-500" /> {ticket.location}
          </p>
        </div>
        <p className="text-xs text-slate-500">
          Reported {formatDateTime(ticket.createdAt)} · waiting{' '}
          <span className="font-medium text-red-600">
            {formatDuration(now - Date.parse(ticket.createdAt))}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className={field}
          value={teamId}
          disabled={saving}
          onChange={(e) => setTeamId(e.target.value)}
        >
          <option value="">Team…</option>
          {TEAMS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          className={field}
          value={priority}
          disabled={saving}
          onChange={(e) => setPriority(e.target.value as Priority)}
        >
          <option value="">Priority…</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p} (fix within {SLA_POLICY[p].fixHours} h)
            </option>
          ))}
        </select>
        <input
          className={`${field} min-w-48 flex-1`}
          placeholder="Reason (optional)"
          maxLength={1000}
          value={reason}
          disabled={saving}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          onClick={assign}
          disabled={saving}
          className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Assigning…' : 'Assign'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export default function TriagePage() {
  const now = useNow();
  const { data, error, loading, reload } = useApi(
    () => api.listUntriaged(),
    'triage',
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Needs triage</h1>
        <p className="text-sm text-slate-500">
          Reports the AI could not classify. Choose the team and priority; the
          SLA clock already started when the report came in.
        </p>
      </div>

      <LoadState
        loading={loading && !data}
        error={error}
        onRetry={reload}
        skeleton={<CardListSkeleton />}
      />

      {data && data.items.length === 0 && (
        <p className="rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-400">
          Nothing waiting. The AI classified every report.
        </p>
      )}

      {data?.items.map((t) => (
        <TriageRow key={t.id} ticket={t} now={now} onDone={reload} />
      ))}
    </div>
  );
}
