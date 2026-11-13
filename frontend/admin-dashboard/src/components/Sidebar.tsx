import { NavLink } from 'react-router';
import {
  UserGroup,
  LayoutGrid,
  Ticket,
  History,
  Settings,
  LogOut,
  Inbox,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../services/api';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../context/AuthContext';

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

const navItems: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/triage', label: 'Needs triage', icon: Inbox },
  { to: '/tickets', label: 'All tickets', icon: Ticket },
  { to: '/staff', label: 'Staff & teams', icon: UserGroup },
  { to: '/history', label: 'History & reports', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const Sidebar = () => {
  const { session, signOut } = useAuth();
  const summary = useApi(() => api.getSummary(), 'sidebar');
  const overdue = summary.data?.overdueCount ?? 0;
  const untriaged = summary.data?.countsByStatus.RECEIVED ?? 0;

  return (
    // shrink-0 stops flexbox from squeezing the sidebar when the content is wide.
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-5 border-r border-slate-200 px-2 py-4">
      <div className="flex flex-col gap-1 px-3">
        <p className="font-bold">Juristic Office</p>
        <p className="text-xs text-slate-400">Admin · web only</p>
      </div>

      <nav className="flex flex-col gap-1 text-sm">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-lg px-3 py-3 ${
                isActive
                  ? 'bg-orange-50 font-medium text-orange-600'
                  : 'text-slate-600 hover:bg-slate-50'
              }`
            }
          >
            <Icon size={18} /> {label}
            {to === '/' && overdue > 0 && (
              <span className="ml-auto rounded-full bg-orange-600 px-2 text-xs text-white">
                {overdue}
              </span>
            )}
            {to === '/triage' && untriaged > 0 && (
              <span className="ml-auto rounded-full bg-amber-500 px-2 text-xs text-white">
                {untriaged}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 border-t border-slate-100 px-3 pt-4 text-sm">
        <p className="truncate font-medium text-slate-700">
          {session?.staff.name}
        </p>
        <button
          onClick={signOut}
          className="flex items-center gap-2 text-slate-500 hover:text-orange-600"
        >
          <LogOut size={16} /> Log out
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
