import { MapPin } from 'lucide-react';
import { PriorityBadge, StatusBadge } from './Badges';
import { shortId, slaLeft, teamLabel } from '../lib/format';
import type { Ticket } from '../services/types';

type Props = { tickets: Ticket[]; now: number; onSelect: (id: string) => void };

const NEW_MS = 60 * 60 * 1000; // created in the last hour -> "new" tag

export default function TicketTable({ tickets, now, onSelect }: Props) {
  if (tickets.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-400">No tickets.</p>
    );
  }

  const th = 'px-3 py-3 text-left font-normal text-slate-500';

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200">
          <th className={th}>Ticket</th>
          <th className={th}>Issue</th>
          <th className={th}>Assigned team</th>
          <th className={th}>Priority</th>
          <th className={th}>Status</th>
          <th className={th}>SLA left</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => {
          const sla = slaLeft(t, now);
          const isNew = now - Date.parse(t.createdAt) < NEW_MS;
          return (
            <tr
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
            >
              <td className="px-3 py-4 align-top">
                <p className="font-bold">{shortId(t.id)}</p>
                {isNew && (
                  <span className="mt-1 inline-block rounded-full bg-blue-50 px-2 text-xs text-blue-600">
                    new
                  </span>
                )}
              </td>
              <td className="max-w-xs px-3 py-4">
                <p className="line-clamp-2">{t.description}</p>
                <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                  <MapPin size={12} className="shrink-0 text-red-500" />{' '}
                  {t.location}
                </p>
              </td>
              <td className="px-3 py-4">{teamLabel(t.teamId)}</td>
              <td className="px-3 py-4">
                <PriorityBadge priority={t.priority} />
              </td>
              <td className="px-3 py-4">
                <StatusBadge status={t.status} />
              </td>
              <td
                className={`whitespace-nowrap px-3 py-4 ${
                  sla.overdue
                    ? 'font-medium text-red-600'
                    : sla.text === 'closed'
                      ? 'text-slate-400'
                      : ''
                }`}
              >
                {sla.text}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
