import { STATUS_LABEL } from '../lib/format';
import type { TicketStatus } from '../services/api';

// Same colours as the staff UI's StatusBadge.
const STATUS_STYLE: Record<TicketStatus, string> = {
  RECEIVED: 'bg-slate-100 text-slate-600',
  ASSIGNED: 'bg-amber-50 text-amber-700',
  IN_PROGRESS: 'bg-orange-50 text-orange-600',
  DONE: 'bg-green-50 text-green-700',
  MERGED: 'bg-slate-100 text-slate-500',
};

export default function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
