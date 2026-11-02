import { Link } from 'react-router';
import { MapPin } from 'lucide-react';
import type { Ticket } from '../services/types';
import { PriorityLabel, StatusBadge } from './TicketBadges';
import { formatTimeLeft } from '../utils/time';

type JobCardProps = {
  ticket: Ticket;
};

export default function JobCard({ ticket }: JobCardProps) {
  return (
    <Link
      to={`/tech/jobs/${ticket.id}`}
      className="block rounded-lg border border-gray-200 bg-white p-3 hover:bg-gray-50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">
          #{ticket.id}
        </span>
        <StatusBadge status={ticket.status} />
      </div>

      <p className="mt-1 truncate text-sm">{ticket.description}</p>

      <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
        <MapPin size={12} className="shrink-0" />
        <span className="truncate">{ticket.location}</span>
      </p>

      <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
        {ticket.priority && <PriorityLabel priority={ticket.priority} />}
        {ticket.deadlineAt && <span>{formatTimeLeft(ticket.deadlineAt)}</span>}
      </div>
    </Link>
  );
}
