import { useSearchParams } from 'react-router';
import JobCard from '../../components/JobCard';
import LoadState from '../../components/LoadState';
import { Skeleton } from '../../components/Skeleton';
import TechHeader from '../../components/TechHeader';
import { useAuth, useStaff } from '../../context/AuthContext';
import { useApi } from '../../hooks/useApi';
import { useNow } from '../../hooks/useNow';
import { listTeamTickets } from '../../services/api';
import type { TicketStatus } from '../../services/types';

type TabKey = 'active' | 'completed';

const TABS: Record<TabKey, { label: string; statuses: TicketStatus[] }> = {
  active: { label: 'Team jobs', statuses: ['ASSIGNED', 'IN_PROGRESS'] },
  completed: { label: 'Completed', statuses: ['DONE'] },
};

const TAB_KEYS: TabKey[] = ['active', 'completed'];

export default function JobsPage() {
  const staff = useStaff();
  const { signOut } = useAuth();
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabKey =
    searchParams.get('tab') === 'completed' ? 'completed' : 'active';
  const jobs = useApi(() => listTeamTickets(TABS[tab].statuses), tab);
  const teamName = staff.teamName ?? staff.name;

  return (
    <div>
      <TechHeader
        title="Team jobs"
        subtitle={teamName}
        initial={teamName.charAt(0)}
        onSignOut={signOut}
      />

      <nav className="flex border-b border-gray-200">
        {TAB_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() =>
              setSearchParams(key === 'active' ? {} : { tab: key })
            }
            aria-current={tab === key ? 'page' : undefined}
            className={`flex-1 border-b-2 py-3 text-sm font-medium ${
              tab === key
                ? 'border-orange-600 text-orange-600'
                : 'border-transparent text-gray-500'
            }`}
          >
            {TABS[key].label}
            {key === tab && jobs.data && !jobs.loading
              ? ` (${jobs.data.length})`
              : ''}
          </button>
        ))}
      </nav>

      <div className="p-3">
        <LoadState
          loading={jobs.loading}
          error={jobs.error}
          onRetry={jobs.reload}
          skeleton={
            <div className="flex flex-col gap-2">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
          }
        />
        {jobs.data &&
          !jobs.loading &&
          !jobs.error &&
          (jobs.data.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">
              No jobs here.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {jobs.data.map((ticket) => (
                <li key={ticket.id}>
                  <JobCard ticket={ticket} now={now} />
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
