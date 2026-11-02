import { useEffect, useState, type ChangeEvent } from 'react';
import { useParams } from 'react-router';
import { Camera, CheckCircle2, MapPin, Play } from 'lucide-react';
import TechHeader from '../../components/TechHeader';
import { PriorityLabel, StatusBadge } from '../../components/TicketBadges';
import { useCurrentStaff } from '../../services/session';
import {
  markDone,
  startWork,
  TicketActionError,
  uploadRepairProof,
  useTicket,
} from '../../services/tickets';
import { formatTimeLeft } from '../../utils/time';

type Proof = { uploadId: string; previewUrl: string };

export default function JobDetailPage() {
  const { ticketId } = useParams();
  const ticket = useTicket(ticketId);
  const staff = useCurrentStaff();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [proof, setProof] = useState<Proof>();

  // Free the browser memory used by the preview image when it is replaced or the page closes.
  useEffect(() => {
    if (!proof) return;
    return () => URL.revokeObjectURL(proof.previewUrl);
  }, [proof]);

  if (!ticket || ticket.teamId !== staff.teamId) {
    return (
      <div>
        <TechHeader title="Job not found" backTo="/tech" />
        <p className="p-6 text-center text-sm text-gray-500">
          This job doesn't exist or isn't assigned to your team.
        </p>
      </div>
    );
  }

  const isMine = ticket.acceptedByStaffId === staff.id;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof TicketActionError
          ? e.message
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  function handleProofSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void run(async () => {
      const uploadId = await uploadRepairProof(file);
      setProof({ uploadId, previewUrl: URL.createObjectURL(file) });
    });
  }

  return (
    <div>
      <TechHeader
        title={`#${ticketId}`}
        subtitle={ticket.category}
        backTo="/tech"
      />
      <div className="flex flex-col gap-4 p-3">
        <section>
          <h2 className="text-base font-semibold">{ticket.description}</h2>
          <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
            <MapPin size={12} className="shrink-0" />
            {ticket.location}
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
            <StatusBadge status={ticket.status} />
            {ticket.priority && <PriorityLabel priority={ticket.priority} />}
            {ticket.deadlineAt && (
              <span>{formatTimeLeft(ticket.deadlineAt)}</span>
            )}
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-xs text-gray-500">Resident's photo</h3>
          <div className="flex h-32 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-400">
            Photo shown once the photo-access API exists
          </div>
        </section>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        {ticket.status === 'ASSIGNED' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => startWork(ticket.id, staff))}
            className="flex items-center justify-center gap-2 rounded-lg bg-orange-600 py-3 font-semibold text-white disabled:opacity-50"
          >
            <Play size={16} />
            {busy ? 'Starting…' : 'Start work'}
          </button>
        )}

        {ticket.status === 'IN_PROGRESS' && !isMine && (
          <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
            Another technician is working on this job.
          </p>
        )}

        {ticket.status === 'IN_PROGRESS' && isMine && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs text-gray-500">
              Proof-of-repair photo (required)
            </h3>
            <label className="flex h-32 cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-gray-300 text-xs text-gray-500">
              {proof ? (
                <img
                  src={proof.previewUrl}
                  alt="Proof of repair"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex items-center gap-1">
                  <Camera size={14} />
                  Upload after-repair photo
                </span>
              )}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                disabled={busy}
                onChange={handleProofSelected}
              />
            </label>
            <button
              type="button"
              disabled={busy || !proof}
              onClick={() => {
                if (proof)
                  void run(() => markDone(ticket.id, staff, proof.uploadId));
              }}
              className="flex items-center justify-center gap-2 rounded-lg bg-green-600 py-3 font-semibold text-white disabled:opacity-40"
            >
              <CheckCircle2 size={16} />
              {busy ? 'Saving…' : 'Mark as done'}
            </button>
          </section>
        )}

        {ticket.status === 'DONE' && (
          <p className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
            Job completed
            {ticket.completedAt &&
              ` on ${new Date(ticket.completedAt).toLocaleString()}`}
            .
          </p>
        )}
      </div>
    </div>
  );
}
