import { Link } from 'react-router';
import { MapPin } from 'lucide-react';
import type { Priority, Ticket, TicketStatus } from '../services/types';
import { formatTimeLeft } from '../utils/time';

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

type JobCardProps = {
  ticket: Ticket;
};

export default function JobCard({ ticket }: JobCardProps) {
  const status = STATUS_STYLE[ticket.status];

  return (
    <Link
      to={`/tech/jobs/${ticket.id}`}
      className="block rounded-lg border border-gray-200 bg-white p-3 hover:bg-gray-50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">
          #{ticket.id}
        </span>
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${status.className}`}
        >
          {status.label}
        </span>
      </div>

      <p className="mt-1 truncate text-sm">{ticket.description}</p>

      <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
        <MapPin size={12} className="shrink-0" />
        <span className="truncate">{ticket.location}</span>
      </p>

      <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
        {ticket.priority && (
          <span className="flex items-center gap-1 font-semibold text-gray-700">
            <span
              className={`h-2 w-2 rounded-full ${PRIORITY_DOT[ticket.priority]}`}
            />
            {ticket.priority}
          </span>
        )}
        {ticket.deadlineAt && <span>{formatTimeLeft(ticket.deadlineAt)}</span>}
      </div>
    </Link>
  );
}
