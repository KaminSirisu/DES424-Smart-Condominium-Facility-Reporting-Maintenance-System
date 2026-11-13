import { Link } from 'react-router';
import { MapPin } from 'lucide-react';
import { PriorityBadge, StatusBadge } from './Badges';
import { isOpen, shortId, slaLeft } from '../lib/format';
import type { Ticket } from '../services/types';

type JobCardProps = { ticket: Ticket; now: number };

export default function JobCard({ ticket, now }: JobCardProps) {
  const sla = slaLeft(ticket, now);
  return (
    <Link
      to={`/tech/jobs/${ticket.id}`}
      className="block rounded-lg border border-gray-200 bg-white p-3 hover:bg-gray-50"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{shortId(ticket.id)}</span>
        <StatusBadge status={ticket.status} />
      </div>
      <p className="mt-1 truncate text-sm">{ticket.description}</p>
      <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
        <MapPin size={12} className="shrink-0" />
        <span className="truncate">{ticket.location}</span>
      </p>
      <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
        <PriorityBadge priority={ticket.priority} />
        {isOpen(ticket) && ticket.deadlineAt && (
          <span className={sla.overdue ? 'font-semibold text-red-600' : ''}>
            {sla.text}
          </span>
        )}
      </div>
    </Link>
  );
}
