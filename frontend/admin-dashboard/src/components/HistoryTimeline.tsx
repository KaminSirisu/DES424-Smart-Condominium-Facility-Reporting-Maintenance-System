import { useTicketEvents } from '../services/tickets';
import type { TicketEvent } from '../services/types';

function describeEvent(event: TicketEvent): string {
  switch (event.kind) {
    case 'CREATED':
      return 'Report received via LINE';
    case 'TRIAGED':
      return event.toPriority
        ? `AI set priority ${event.toPriority}`
        : 'Assigned by AI';
    case 'STATUS_CHANGED':
      if (event.toStatus === 'IN_PROGRESS') return 'Work started';
      if (event.toStatus === 'DONE') return 'Marked as done';
      return `Status changed to ${event.toStatus}`;
    case 'PRIORITY_CONFIRMED':
      return `Priority ${event.toPriority} accepted`;
    case 'PRIORITY_CHANGED':
      return `Priority ${event.fromPriority} → ${event.toPriority}`;
    case 'MERGED':
    case 'DUPLICATES_MERGED':
      return event.note ?? 'Merged';
    default:
      return event.kind;
  }
}

export default function HistoryTimeline({ ticketId }: { ticketId: string }) {
  const events = useTicketEvents(ticketId);

  return (
    <section>
      <h3 className="mb-2 text-xs text-gray-500">History</h3>
      <ol className="relative ml-1.5 border-l border-gray-200">
        {events.map((event) => (
          <li key={event.id} className="mb-3 ml-4">
            <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full bg-green-500" />
            <p className="text-sm font-medium">{describeEvent(event)}</p>
            {event.kind === 'PRIORITY_CHANGED' && event.note && (
              <p className="text-xs text-gray-600">“{event.note}”</p>
            )}
            <p className="text-xs text-gray-500">
              {new Date(event.occurredAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
