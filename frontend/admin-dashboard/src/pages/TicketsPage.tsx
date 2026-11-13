import { useState } from 'react';
import { Download, Search } from 'lucide-react';
import { getAllHistory } from '../services/api';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import LoadState from '../components/LoadState';
import { PageSkeleton } from '../components/Skeleton';
import TicketTable from '../components/TicketTable';
import TicketDrawer from '../components/TicketDrawer';
import { exportTickets, matchesSearch } from '../lib/tickets';
import type { TicketStatus } from '../services/types';

const RANK: Record<TicketStatus, number> = {
  RECEIVED: 0,
  ASSIGNED: 0,
  IN_PROGRESS: 0,
  DONE: 1,
  MERGED: 2,
};

export default function TicketsPage() {
  const now = useNow();
  const { data, error, loading, reload } = useApi(
    () => getAllHistory(),
    'tickets',
  );
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  if (!data)
    return (
      <LoadState
        loading={loading}
        error={error}
        onRetry={reload}
        skeleton={<PageSkeleton cards={0} rows={8} />}
      />
    );

  const rows = data.items
    .map((e) => e.ticket)
    .filter((t) => matchesSearch(t, search))
    .sort(
      (a, b) =>
        RANK[a.status] - RANK[b.status] ||
        b.createdAt.localeCompare(a.createdAt),
    );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">All tickets</h1>
        <div className="flex gap-2">
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
            <Search size={16} className="text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="text-sm outline-none"
            />
          </label>
          <button
            onClick={() => exportTickets(rows, now, 'all-tickets.csv')}
            className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
          >
            <Download size={16} /> Export CSV
          </button>
        </div>
      </header>

      <section className="overflow-x-auto rounded-2xl border border-slate-200 p-5">
        <TicketTable tickets={rows} now={now} onSelect={setSelected} />
      </section>

      {selected && (
        <TicketDrawer
          ticketId={selected}
          onClose={() => setSelected(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
