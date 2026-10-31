import { NavLink } from 'react-router';
import {
  UserGroup,
  LayoutGrid,
  Ticket,
  History,
  Settings,
  type LucideIcon,
} from 'lucide-react';

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

const navItems: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/tickets', label: 'All tickets', icon: Ticket },
  { to: '/staff', label: 'Staff & teams', icon: UserGroup },
  { to: '/history', label: 'History & reports', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const Sidebar = () => {
  return (
    // shrink-0 stops flexbox from squeezing the sidebar when the content is wide.
    <aside className="flex w-60 flex-col gap-5 border-r border-slate-200 px-2 py-4 sticky top-0 h-screen shrink-0">
      <div className="flex flex-col gap-1 px-3">
        <p className="font-bold">Juristic Office</p>
        <p className="text-xs text-slate-400">Admin · web only</p>
      </div>
      <nav className="flex flex-col text-sm gap-1">
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
          </NavLink>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
