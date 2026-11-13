import { useAction } from '../hooks/useAction';
import { shortId } from '../lib/format';
import { api } from '../services/api';
import type { Ticket } from '../services/types';

type DuplicateListProps = {
  ticket: Ticket;
  candidates: Ticket[];
  onChanged: () => void;
};

export default function DuplicateList({
  ticket,
  candidates,
  onChanged,
}: DuplicateListProps) {
  const { busy, error, run } = useAction();

  if (candidates.length === 0) return null;

  function handleMerge(source: Ticket) {
    const confirmed = window.confirm(
      `Merge ${shortId(source.id)} into this job? Its reporter will follow this job instead. This cannot be undone.`,
    );
    if (!confirmed) return;
    // One key per merge attempt: a retry after a dropped connection is answered 200, not merged twice.
    const idempotencyKey = crypto.randomUUID();
    void run(async () => {
      await api.merge(ticket.id, [source.id], idempotencyKey);
      onChanged();
    });
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
              {shortId(candidate.id)} · {candidate.description}
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
