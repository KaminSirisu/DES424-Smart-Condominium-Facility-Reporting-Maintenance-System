import type { Priority, TicketStatus } from '../services/types';

const STATUS_STYLE: Record<TicketStatus, { label: string; className: string }> =
  {
    RECEIVED: { label: 'Received', className: 'bg-gray-100 text-gray-600' },
    ASSIGNED: { label: 'Assigned', className: 'bg-amber-100 text-amber-700' },
    IN_PROGRESS: {
      label: 'In progress',
      className: 'bg-orange-100 text-orange-700',
    },
    DONE: { label: 'Done', className: 'bg-green-100 text-green-700' },
    MERGED: { label: 'Merged', className: 'bg-slate-100 text-slate-500' },
  };

const PRIORITY_DOT: Record<Priority, string> = {
  CRITICAL: 'bg-red-500',
  MEDIUM: 'bg-amber-500',
  LOW: 'bg-gray-400',
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}

export function PriorityLabel({ priority }: { priority: Priority }) {
  return (
    <span className="flex items-center gap-1 text-xs font-semibold text-gray-700">
      <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[priority]}`} />
      {priority}
    </span>
  );
}
