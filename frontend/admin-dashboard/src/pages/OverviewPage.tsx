import { useState } from 'react';
import { Download, Search, TriangleAlert } from 'lucide-react';
import { api, getAllHistory } from '../services/api';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import StatCard from '../components/StatCard';
import LoadState from '../components/LoadState';
import TicketTable from '../components/TicketTable';
import TicketDrawer from '../components/TicketDrawer';
import { formatDateTime, isOpen, isOverdue, shortId, slaLeft, teamLabel } from '../lib/format';
import { exportTickets, matchesSearch } from '../lib/tickets';

type Filter = 'ALL' | 'ASSIGNED' | 'IN_PROGRESS' | 'OVERDUE';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'ALL', label: 'All open' },
  { id: 'ASSIGNED', label: 'Assigned' },
  { id: 'IN_PROGRESS', label: 'In progress' },
  { id: 'OVERDUE', label: 'Overdue' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export default function OverviewPage() {
  const now = useNow();
  const { data, error, loading, reload } = useApi(
    () => Promise.all([api.getSummary(), getAllHistory()]),
    'overview',
  );
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const [summary, history] = data;

  const tickets = history.items.map((e) => e.ticket);
  const open = tickets.filter(isOpen);
  const breaches = open.filter((t) => isOverdue(t, now));
  const closed24h = tickets.filter(
    (t) => t.status === 'DONE' && t.completedAt && now - Date.parse(t.completedAt) < DAY_MS,
  ).length;

  const rows = open
    .filter((t) => {
      if (filter === 'ALL') return true;
      if (filter === 'OVERDUE') return isOverdue(t, now);
      return t.status === filter;
    })
    .filter((t) => matchesSearch(t, search));

  const maxLoad = Math.max(1, ...summary.teamWorkloads.map((w) => w.openCount));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Maintenance overview</h1>
          <p className="text-sm text-slate-500">● Live · {formatDateTime(summary.generatedAt)}</p>
        </div>
        <div className="flex gap-2">
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
            <Search size={16} className="text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ticket, spot, team"
              className="text-sm outline-none"
            />
          </label>
          <button
            onClick={() => exportTickets(rows, now, 'open-tickets.csv')}
            className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
          >
            <Download size={16} /> Export CSV
          </button>
        </div>
      </header>

      {error && <LoadState loading={false} error={error} onRetry={reload} />}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Assigned to teams" value={summary.countsByStatus.ASSIGNED} />
        <StatCard label="In progress" value={summary.countsByStatus.IN_PROGRESS} />
        <StatCard label="Closed (24h)" value={closed24h} />
        <StatCard label="SLA breached" value={summary.overdueCount ?? 0} danger />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <section className="overflow-x-auto rounded-2xl border border-slate-200 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold">Open tickets</h2>
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                    filter === f.id
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <TicketTable tickets={rows} now={now} onSelect={setSelected} />
        </section>

        <div className="flex flex-col gap-6">
          <section className="rounded-2xl border border-slate-200 p-5">
            <h2 className="mb-3 flex items-center gap-2 font-bold">
              <TriangleAlert size={18} className="text-red-600" /> SLA breaches
              <span className="ml-auto rounded-full bg-red-600 px-2 text-xs text-white">
                {breaches.length}
              </span>
            </h2>
            {breaches.length === 0 && <p className="text-sm text-slate-400">No breaches.</p>}
            <div className="flex flex-col gap-2">
              {breaches.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className="rounded-lg border-l-4 border-red-600 bg-red-50 p-3 text-left hover:bg-red-100"
                >
                  <p className="text-sm font-bold">
                    {shortId(t.id)} <span className="font-medium">{t.description}</span>
                  </p>
                  <p className="text-xs text-slate-600">
                    {teamLabel(t.teamId)} ·{' '}
                    <span className="font-medium text-red-600">{slaLeft(t, now).text}</span>
                  </p>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 p-5">
            <h2 className="mb-4 font-bold">Team workload (open jobs)</h2>
            <div className="flex flex-col gap-3">
              {summary.teamWorkloads.map((w) => (
                <div key={w.teamId} className="grid grid-cols-[130px_1fr_24px] items-center gap-3 text-sm">
                  <span>{teamLabel(w.teamId)}</span>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div
                      className="h-2 rounded-full bg-orange-600"
                      style={{ width: `${(w.openCount / maxLoad) * 100}%` }}
                    />
                  </div>
                  <span className="text-right">{w.openCount}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {selected && (
        <TicketDrawer ticketId={selected} onClose={() => setSelected(null)} onSaved={reload} />
      )}
    </div>
  );
}