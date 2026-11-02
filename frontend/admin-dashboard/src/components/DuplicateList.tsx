import { useAction } from '../hooks/useAction';
import { mergeTickets, useDuplicateCandidates } from '../services/tickets';
import type { StaffProfile, Ticket } from '../services/types';

type DuplicateListProps = {
  ticket: Ticket;
  staff: StaffProfile;
};

export default function DuplicateList({ ticket, staff }: DuplicateListProps) {
  const candidates = useDuplicateCandidates(ticket);
  const { busy, error, run } = useAction();

  if (candidates.length === 0) return null;

  function handleMerge(source: Ticket) {
    const confirmed = window.confirm(
      `Merge #${source.id} into this job? Its reporter will follow this job instead. This cannot be undone.`,
    );
    if (confirmed) void run(() => mergeTickets(ticket.id, staff, [source.id]));
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs text-gray-500">
        Possible duplicates at this spot
      </h3>
      <ul className="flex flex-col gap-2">
        {candidates.map((candidate) => (
          <li
            key={candidate.id}
            className="rounded-lg border border-gray-200 p-3"
          >
            <p className="truncate text-sm">
              #{candidate.id} · {candidate.description}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleMerge(candidate)}
              className="mt-2 rounded-md border border-gray-300 px-3 py-1 text-xs disabled:opacity-50"
            >
              Merge into this job
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
