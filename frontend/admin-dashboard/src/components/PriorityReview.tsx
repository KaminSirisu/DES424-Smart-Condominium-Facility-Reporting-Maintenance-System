import { useState } from 'react';
import { Check } from 'lucide-react';
import { useAction } from '../hooks/useAction';
import { setPriority } from '../services/tickets';
import type { Priority, StaffProfile, Ticket } from '../services/types';

const PRIORITIES: Priority[] = ['CRITICAL', 'MEDIUM', 'LOW'];

type PriorityReviewProps = {
  ticket: Ticket;
  staff: StaffProfile;
};

export default function PriorityReview({ ticket, staff }: PriorityReviewProps) {
  const { busy, error, run } = useAction();
  const [choice, setChoice] = useState<Priority | undefined>(ticket.priority);
  const [reason, setReason] = useState('');

  const current = ticket.priority;
  if (!current) {
    return <p className="text-sm text-gray-500">Waiting for AI triage.</p>;
  }
  const changed = choice !== current;

  function handleUpdate() {
    if (!choice) return;
    void run(async () => {
      await setPriority(ticket.id, staff, choice, reason);
      setReason('');
    });
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs text-gray-500">Review AI priority</h3>

      {ticket.prioritySetBy === 'STAFF' ? (
        <p className="flex items-center gap-1 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-700">
          <Check size={16} />
          Priority accepted
        </p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => setPriority(ticket.id, staff, current))}
          className="flex items-center justify-center gap-1 rounded-lg border border-gray-300 py-2.5 text-sm disabled:opacity-50"
        >
          <Check size={16} />
          Accept {current}
        </button>
      )}

      <div className="flex gap-2">
        <select
          aria-label="New priority"
          value={choice}
          disabled={busy}
          onChange={(e) => setChoice(e.target.value as Priority)}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !changed || !reason.trim()}
          onClick={handleUpdate}
          className="rounded-lg border border-gray-300 px-4 text-sm disabled:opacity-40"
        >
          Update
        </button>
      </div>

      {changed && (
        <input
          type="text"
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why change the priority?"
          aria-label="Reason for priority change"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
