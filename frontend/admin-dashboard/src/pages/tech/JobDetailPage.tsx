import { useEffect, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Camera, CheckCircle2, MapPin, Play } from 'lucide-react';
import { PriorityBadge, StatusBadge } from '../../components/Badges';
import DuplicateList from '../../components/DuplicateList';
import HistoryTimeline from '../../components/HistoryTimeline';
import LoadState from '../../components/LoadState';
import PhotoPreview from '../../components/PhotoPreview';
import PriorityReview from '../../components/PriorityReview';
import { Skeleton } from '../../components/Skeleton';
import TechHeader from '../../components/TechHeader';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useNow } from '../../hooks/useNow';
import { formatDateTime, shortId, slaLeft, teamLabel } from '../../lib/format';
import { api, uploadRepairProof } from '../../services/api';

type Proof = { uploadId: string; previewUrl: string };

export default function JobDetailPage() {
  const { ticketId = '' } = useParams();
  // A new key per ticket gives a fresh page, so proof or errors never carry over to another job.
  return <JobDetail key={ticketId} ticketId={ticketId} />;
}

function JobDetail({ ticketId }: { ticketId: string }) {
  // Bumping version reloads the ticket, history and duplicates together after an action.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const ticket = useApi(() => api.getTicket(ticketId), version);
  const events = useApi(() => api.listEvents(ticketId), version);
  const duplicates = useApi(() => api.listDuplicates(ticketId), version);
  const now = useNow();
  const { busy, error, run } = useAction();
  const [proof, setProof] = useState<Proof>();

  // Free the browser memory used by the preview image when it is replaced or the page closes.
  useEffect(() => {
    if (!proof) return;
    return () => URL.revokeObjectURL(proof.previewUrl);
  }, [proof]);

  if (!ticket.data) {
    return (
      <div>
        <TechHeader title={shortId(ticketId)} backTo="/tech" />
        <div className="flex flex-col gap-3 p-3">
          <LoadState
            loading={ticket.loading}
            error={ticket.error}
            onRetry={ticket.reload}
            skeleton={
              <>
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-40 w-full rounded-lg" />
              </>
            }
          />
        </div>
      </div>
    );
  }

  const t = ticket.data;
  const open = t.status === 'ASSIGNED' || t.status === 'IN_PROGRESS';
  const sla = slaLeft(t, now);
  const defectPhoto = t.photos.find((p) => p.purpose === 'DEFECT');
  const proofPhoto = [...t.photos]
    .reverse()
    .find(
      (p) => p.purpose === 'REPAIR_PROOF' && p.repairCycle === t.repairCycle,
    );

  function handleStart() {
    void run(async () => {
      await api.setStatus(t.id, 'IN_PROGRESS');
      refresh();
    });
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

  function handleDone() {
    if (!proof) return;
    const { uploadId } = proof;
    void run(async () => {
      await api.setStatus(t.id, 'DONE', uploadId);
      setProof(undefined);
      refresh();
    });
  }

  return (
    <div>
      <TechHeader
        title={shortId(t.id)}
        subtitle={teamLabel(t.teamId)}
        backTo="/tech"
      />

      <div className="flex flex-col gap-5 p-3">
        <section>
          <h2 className="text-base font-semibold">{t.description}</h2>
          <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
            <MapPin size={12} className="shrink-0" />
            {t.location}
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            {open && t.deadlineAt && (
              <span className={sla.overdue ? 'font-semibold text-red-600' : ''}>
                {sla.text}
              </span>
            )}
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-xs text-gray-500">Resident's photo</h3>
          {defectPhoto ? (
            <PhotoPreview
              ticketId={t.id}
              photoId={defectPhoto.id}
              alt="Resident's photo"
            />
          ) : (
            <p className="text-sm text-gray-500">No photo.</p>
          )}
        </section>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        {t.status === 'ASSIGNED' && (
          <button
            type="button"
            disabled={busy}
            onClick={handleStart}
            className="flex items-center justify-center gap-2 rounded-lg bg-orange-600 py-3 font-semibold text-white disabled:opacity-50"
          >
            <Play size={16} />
            {busy ? 'Starting…' : 'Start work'}
          </button>
        )}

        {t.status === 'IN_PROGRESS' && (
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
                  {busy ? 'Uploading…' : 'Upload after-repair photo'}
                </span>
              )}
              <input
                type="file"
                accept="image/jpeg,image/png"
                capture="environment"
                className="sr-only"
                disabled={busy}
                onChange={handleProofSelected}
              />
            </label>
            <button
              type="button"
              disabled={busy || !proof}
              onClick={handleDone}
              className="flex items-center justify-center gap-2 rounded-lg bg-green-600 py-3 font-semibold text-white disabled:opacity-40"
            >
              <CheckCircle2 size={16} />
              {busy && proof ? 'Saving…' : 'Mark as done'}
            </button>
          </section>
        )}

        {t.status === 'DONE' && (
          <section className="flex flex-col gap-2">
            <p className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
              Job completed
              {t.completedAt && ` on ${formatDateTime(t.completedAt)}`}.
            </p>
            {proofPhoto && (
              <PhotoPreview
                ticketId={t.id}
                photoId={proofPhoto.id}
                alt="Proof of repair"
              />
            )}
          </section>
        )}

        {t.status === 'MERGED' && t.mergedIntoTicketId && (
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            Merged into{' '}
            <Link
              to={`/tech/jobs/${t.mergedIntoTicketId}`}
              className="underline"
            >
              {shortId(t.mergedIntoTicketId)}
            </Link>
          </p>
        )}

        {open && <PriorityReview ticket={t} onChanged={refresh} />}
        {open && duplicates.data && (
          <DuplicateList
            ticket={t}
            candidates={duplicates.data.items}
            onChanged={refresh}
          />
        )}
        {events.data && <HistoryTimeline events={events.data.items} />}
        {events.error && (
          <p className="text-xs text-gray-500">
            History unavailable: {events.error}
          </p>
        )}
      </div>
    </div>
  );
}
