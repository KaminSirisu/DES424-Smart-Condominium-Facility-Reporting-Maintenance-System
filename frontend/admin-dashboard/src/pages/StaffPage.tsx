import { api, getAllHistory } from '../services/api';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import StatCard from '../components/StatCard';
import LoadState from '../components/LoadState';
import { TEAMS } from '../lib/constants';
import { formatDateTime, isOverdue, teamLabel } from '../lib/format';

const th = 'px-3 py-3 text-left font-normal text-slate-500';
const td = 'px-3 py-3';

export default function StaffPage() {
  const now = useNow();
  const { data, error, loading, reload } = useApi(
    () => Promise.all([api.getSummary(), getAllHistory(), api.listStaffAccounts()]),
    'staff',
  );
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const [summary, history, accounts] = data;

  const tickets = history.items.map((e) => e.ticket);
  const rows = TEAMS.map((team) => {
    const mine = tickets.filter((t) => t.teamId === team.id);
    return {
      ...team,
      assigned: mine.filter((t) => t.status === 'ASSIGNED').length,
      inProgress: mine.filter((t) => t.status === 'IN_PROGRESS').length,
      overdue: mine.filter((t) => isOverdue(t, now)).length,
      completed: mine.filter((t) => t.status === 'DONE').length,
    };
  });
  const activeTechnicians = accounts.items.filter(
    (a) => a.role === 'TECHNICIAN' && a.isActive,
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Staff & teams</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Teams" value={TEAMS.length} />
        <StatCard label="Active technicians" value={activeTechnicians} />
        <StatCard
          label="Open team jobs"
          value={summary.countsByStatus.ASSIGNED + summary.countsByStatus.IN_PROGRESS}
        />
        <StatCard label="SLA breached" value={summary.overdueCount ?? 0} danger />
      </div>

      <section className="overflow-x-auto rounded-2xl border border-slate-200 p-5">
        <h2 className="mb-2 font-bold">Team workload & SLA</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={th}>Maintenance team</th>
              <th className={th}>Assigned</th>
              <th className={th}>In progress</th>
              <th className={th}>Overdue</th>
              <th className={th}>Completed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className={`${td} font-bold`}>{r.label}</td>
                <td className={td}>{r.assigned}</td>
                <td className={td}>{r.inProgress}</td>
                <td className={`${td} ${r.overdue ? 'font-bold text-red-600' : ''}`}>{r.overdue}</td>
                <td className={td}>{r.completed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="overflow-x-auto rounded-2xl border border-slate-200 p-5">
        <h2 className="font-bold">Staff accounts</h2>
        <p className="mb-2 text-xs text-slate-500">Accounts are created by the system administrator.</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={th}>Name</th>
              <th className={th}>Email</th>
              <th className={th}>Role</th>
              <th className={th}>Team</th>
              <th className={th}>Status</th>
              <th className={th}>Last login</th>
            </tr>
          </thead>
          <tbody>
            {accounts.items.map((a) => (
              <tr key={a.accountId} className="border-b border-slate-100">
                <td className={`${td} font-medium`}>{a.displayName}</td>
                <td className={td}>{a.email}</td>
                <td className={td}>{a.role === 'MANAGER' ? 'Manager' : 'Technician'}</td>
                <td className={td}>{teamLabel(a.teamId)}</td>
                <td className={td}>
                  {a.isActive ? 'Active' : <span className="text-slate-400">Disabled</span>}
                </td>
                <td className={td}>{a.lastLoginAt ? formatDateTime(a.lastLoginAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}