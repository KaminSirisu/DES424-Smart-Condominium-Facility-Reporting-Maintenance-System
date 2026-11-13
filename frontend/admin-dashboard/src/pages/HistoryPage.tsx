import { Download, MapPin } from 'lucide-react';
import { getAllHistory } from '../services/api';
import { useApi } from '../hooks/useApi';
import StatCard from '../components/StatCard';
import LoadState from '../components/LoadState';
import { PageSkeleton } from '../components/Skeleton';
import { downloadCsv } from '../lib/csv';
import { hoursBetween, shortId, teamLabel } from '../lib/format';

const th = 'px-3 py-3 text-left font-normal text-slate-500';

export default function HistoryPage() {
  const { data, error, loading, reload } = useApi(
    () => getAllHistory(),
    'history',
  );
  if (!data)
    return (
      <LoadState
        loading={loading}
        error={error}
        onRetry={reload}
        skeleton={<PageSkeleton cards={3} />}
      />
    );

  const closed = data.items
    .filter((e) => e.ticket.status === 'DONE')
    .map((e) => {
      const t = e.ticket;
      const finishedAt = t.completedAt ?? e.lastCompletedAt ?? t.updatedAt;
      return {
        ticket: t,
        hours: hoursBetween(t.createdAt, finishedAt),
        met:
          !t.deadlineAt || Date.parse(finishedAt) <= Date.parse(t.deadlineAt),
      };
    });

  const metPct = closed.length
    ? Math.round((closed.filter((c) => c.met).length / closed.length) * 100)
    : 0;
  const avgHours = closed.length
    ? closed.reduce((sum, c) => sum + c.hours, 0) / closed.length
    : 0;

  const areas = new Map<string, { count: number; met: number }>();
  for (const c of closed) {
    const area = areas.get(c.ticket.location) ?? { count: 0, met: 0 };
    area.count += 1;
    if (c.met) area.met += 1;
    areas.set(c.ticket.location, area);
  }

  function exportCsv() {
    downloadCsv('closed-jobs.csv', [
      [
        'Ticket',
        'Description',
        'Location',
        'Team',
        'Priority',
        'Hours taken',
        'SLA',
      ],
      ...closed.map((c) => [
        c.ticket.id,
        c.ticket.description,
        c.ticket.location,
        teamLabel(c.ticket.teamId),
        c.ticket.priority,
        c.hours.toFixed(1),
        c.met ? 'Met' : 'Missed',
      ]),
    ]);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">History & reports</h1>
        <button
          onClick={exportCsv}
          className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
        >
          <Download size={16} /> Export CSV
        </button>
      </header>

      <div className="grid grid-cols-3 gap-4 lg:max-w-2xl">
        <StatCard label="Jobs closed" value={closed.length} />
        <StatCard label="Met SLA" value={`${metPct}%`} />
        <StatCard label="Avg. fix time" value={`${avgHours.toFixed(1)} h`} />
      </div>

      <section className="rounded-2xl border border-slate-200 p-5">
        <h2 className="mb-3 font-bold">By area</h2>
        <div className="flex flex-wrap gap-3">
          {[...areas]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([location, area]) => {
              const pct = Math.round((area.met / area.count) * 100);
              return (
                <div
                  key={location}
                  className="min-w-36 rounded-xl border border-slate-200 p-3"
                >
                  <p className="font-bold">{location}</p>
                  <p className="text-2xl font-bold">{area.count}</p>
                  <p className="text-xs text-slate-500">
                    Met SLA{' '}
                    <span
                      className={
                        pct === 100 ? 'text-green-600' : 'text-red-600'
                      }
                    >
                      {pct}%
                    </span>
                  </p>
                </div>
              );
            })}
          {areas.size === 0 && (
            <p className="text-sm text-slate-400">No closed jobs yet.</p>
          )}
        </div>
      </section>

      <section className="overflow-x-auto rounded-2xl border border-slate-200 p-5">
        <h2 className="mb-2 font-bold">Closed jobs</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={th}>Ticket</th>
              <th className={th}>Issue</th>
              <th className={th}>Assigned team</th>
              <th className={th}>Time taken</th>
              <th className={th}>SLA</th>
            </tr>
          </thead>
          <tbody>
            {closed.map(({ ticket: t, hours, met }) => (
              <tr key={t.id} className="border-b border-slate-100">
                <td className="px-3 py-3 font-bold">{shortId(t.id)}</td>
                <td className="px-3 py-3">
                  <p>{t.description}</p>
                  <p className="flex items-center gap-1 text-xs text-slate-500">
                    <MapPin size={12} className="text-red-500" /> {t.location}
                  </p>
                </td>
                <td className="px-3 py-3">{teamLabel(t.teamId)}</td>
                <td className="px-3 py-3">{hours.toFixed(1)} h</td>
                <td className="px-3 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      met
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-600'
                    }`}
                  >
                    {met ? 'Met' : 'Missed'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
