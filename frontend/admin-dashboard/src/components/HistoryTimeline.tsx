import { eventLabel } from '../lib/events';
import { formatDateTime } from '../lib/format';
import type { TicketEvent } from '../services/types';

export default function HistoryTimeline({ events }: { events: TicketEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs text-gray-500">History</h3>
      <ol className="relative ml-1.5 border-l border-gray-200">
        {events.map((event) => (
          <li key={event.id} className="mb-3 ml-4">
            <span
              className={`absolute -left-1.5 mt-1 h-3 w-3 rounded-full ${
                event.kind.startsWith('SLA') ? 'bg-red-500' : 'bg-green-500'
              }`}
            />
            <p className="text-sm font-medium">{eventLabel(event)}</p>
            {event.note && (
              <p className="text-xs text-gray-600">{event.note}</p>
            )}
            <p className="text-xs text-gray-500">
              {formatDateTime(event.occurredAt)}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
