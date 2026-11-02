import { useSearchParams } from 'react-router';
import JobCard from '../../components/JobCard';
import TechHeader from '../../components/TechHeader';
import { useCurrentStaff } from '../../services/session';
import { useTeamTickets } from '../../services/tickets';
import type { TicketStatus } from '../../services/types';

type TabKey = 'active' | 'completed';

const TABS: Record<TabKey, { label: string; statuses: TicketStatus[] }> = {
  active: { label: 'Team jobs', statuses: ['ASSIGNED', 'IN_PROGRESS'] },
  completed: { label: 'Completed', statuses: ['DONE'] },
};

const TAB_KEYS: TabKey[] = ['active', 'completed'];

export default function JobsPage() {
  const staff = useCurrentStaff();
  const tickets = useTeamTickets(staff.teamId);
  const [searchParams, setSearchParams] = useSearchParams();

  const tab: TabKey =
    searchParams.get('tab') === 'completed' ? 'completed' : 'active';
  const inTab = (key: TabKey) =>
    tickets.filter((ticket) => TABS[key].statuses.includes(ticket.status));
  const visible = inTab(tab);

  return (
    <div>
      <TechHeader
        title="Team jobs"
        subtitle={staff.teamName}
        initial={staff.name.charAt(0)}
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
            {TABS[key].label} ({inTab(key).length})
          </button>
        ))}
      </nav>
      {visible.length === 0 ? (
        <p className="p-6 text-center text-sm text-gray-500">No jobs here.</p>
      ) : (
        <ul className="flex flex-col gap-2 p-3">
          {visible.map((ticket) => (
            <li key={ticket.id}>
              <JobCard ticket={ticket} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
