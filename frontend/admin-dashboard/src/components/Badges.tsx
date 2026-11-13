import { STATUS_LABEL } from '../lib/constants';
import type { Priority, TicketStatus } from '../services/types';

const PRIORITY_STYLE: Record<Priority, string> = {
  CRITICAL: 'text-red-600 before:bg-red-600',
  MEDIUM: 'text-amber-600 before:bg-amber-600',
  LOW: 'text-slate-600 before:bg-slate-500',
};

export function PriorityBadge({ priority }: { priority?: Priority }) {
  if (!priority) return <span className="text-slate-400">—</span>;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm font-bold before:h-2.5 before:w-2.5 before:rounded-full before:content-[''] ${PRIORITY_STYLE[priority]}`}
    >
      {priority}
    </span>
  );
}

const STATUS_STYLE: Record<TicketStatus, string> = {
  RECEIVED: 'bg-slate-100 text-slate-600',
  ASSIGNED: 'bg-amber-50 text-amber-700',
  IN_PROGRESS: 'bg-orange-50 text-orange-600',
  DONE: 'bg-green-50 text-green-700',
  MERGED: 'bg-slate-100 text-slate-500',
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
