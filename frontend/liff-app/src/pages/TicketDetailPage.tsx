import { CheckCircle2, MapPin, RotateCcw } from 'lucide-react';
import ErrorBox from '../components/ErrorBox';
import PageHeader from '../components/PageHeader';
import PhotoPreview from '../components/PhotoPreview';
import { TicketSkeleton } from '../components/Skeleton';
import StatusBadge from '../components/StatusBadge';
import { useAsync } from '../hooks/useAsync';
import {
  canReopen,
  defectPhoto,
  formatDateTime,
  latestProofPhoto,
  reopenDeadline,
  shortId,
  teamLabel,
} from '../lib/format';
import { navigate, reopenPath, ticketPath } from '../lib/router';
import { getTicket, type Ticket, type TicketStatus } from '../services/api';

// Opened by "View details and photo" in the LINE message (GET /tickets/{id}).
export default function TicketDetailPage({ ticketId }: { ticketId: string }) {
  const ticket = useAsync(() => getTicket(ticketId), ticketId);

  return (
    <div>
      <PageHeader title={shortId(ticketId)} subtitle="Your report" />
      <div className="flex flex-col gap-5 p-4">
        {ticket.data ? (
          <TicketDetail t={ticket.data} />
        ) : ticket.error ? (
          <ErrorBox message={ticket.error} onRetry={ticket.reload} />
        ) : (
          <TicketSkeleton />
        )}
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium"
        >
          Report another problem
        </button>
      </div>
    </div>
  );
}

function TicketDetail({ t }: { t: Ticket }) {
  const defect = defectPhoto(t);
  const proof = latestProofPhoto(t);
  const team = teamLabel(t.teamId);
  const deadline = reopenDeadline(t);
  const reopenable = canReopen(t);
  const done = t.status === 'DONE';

  const yourPhoto = (
    <section>
      <h3 className="mb-1 text-xs text-gray-500">Your photo</h3>
      {defect ? (
        <PhotoPreview ticketId={t.id} photoId={defect.id} alt="Your photo" />
      ) : (
        <p className="text-sm text-gray-500">No photo.</p>
      )}
    </section>
  );
  const repairPhoto = proof && (
    <section>
      <h3 className="mb-1 text-xs text-gray-500">
        {proof.repairCycle !== undefined && proof.repairCycle < t.repairCycle
          ? 'Earlier repair photo'
          : 'Repair photo'}
      </h3>
      <PhotoPreview
        ticketId={t.id}
        photoId={proof.id}
        alt="Photo of the repair"
      />
    </section>
  );

  return (
    <>
      <section>
        <h2 className="text-base font-semibold">{t.description}</h2>
        <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
          <MapPin size={12} className="shrink-0" />
          {t.location}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <StatusBadge status={t.status} />
          {team && <span>{team} team</span>}
          <span>Reported {formatDateTime(t.createdAt)}</span>
        </div>
        {t.repairCycle > 1 && (
          <p className="mt-2 text-xs text-gray-500">
            Re-opened {t.repairCycle - 1}{' '}
            {t.repairCycle - 1 === 1 ? 'time' : 'times'}.
          </p>
        )}
      </section>

      {t.status === 'MERGED' ? (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          This report was combined with another report of the same problem.
          {t.mergedIntoTicketId && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => navigate(ticketPath(t.mergedIntoTicketId!))}
                className="font-medium underline"
              >
                Follow {shortId(t.mergedIntoTicketId)}
              </button>
            </>
          )}
        </p>
      ) : (
        <Progress status={t.status} />
      )}

      {done && (
        <p className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-700">
          <CheckCircle2 size={16} className="shrink-0" />
          Repair completed
          {t.completedAt && ` on ${formatDateTime(t.completedAt)}`}.
        </p>
      )}

      {/* A finished repair shows its photo first: that is what the LINE message links to. */}
      {done ? (
        <>
          {repairPhoto}
          {yourPhoto}
        </>
      ) : (
        <>
          {yourPhoto}
          {repairPhoto}
        </>
      )}

      {done &&
        (reopenable && deadline ? (
          <section className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => navigate(reopenPath(t.id))}
              className="flex items-center justify-center gap-2 rounded-lg bg-orange-600 py-3 font-semibold text-white active:opacity-80"
            >
              <RotateCcw size={16} />
              Problem still there? Re-open
            </button>
            <p className="text-center text-xs text-gray-500">
              You can re-open until {formatDateTime(deadline.toISOString())}.
            </p>
          </section>
        ) : (
          <p className="text-center text-xs text-gray-500">
            More than 7 days have passed since the repair. If the problem is
            back, please send a new report.
          </p>
        ))}
    </>
  );
}

const STEPS: { status: TicketStatus; label: string }[] = [
  { status: 'RECEIVED', label: 'Received' },
  { status: 'ASSIGNED', label: 'Assigned' },
  { status: 'IN_PROGRESS', label: 'In progress' },
  { status: 'DONE', label: 'Done' },
];

// Where the report is in its journey: Received → Assigned → In progress → Done.
function Progress({ status }: { status: TicketStatus }) {
  const current = STEPS.findIndex((s) => s.status === status);
  return (
    <ol className="grid grid-cols-4 gap-1" aria-label="Progress">
      {STEPS.map((step, i) => {
        const reached = i <= current;
        return (
          <li
            key={step.status}
            aria-current={i === current ? 'step' : undefined}
            className="flex flex-col gap-1"
          >
            <span
              className={`h-1.5 rounded-full ${reached ? 'bg-[#06C755]' : 'bg-slate-200'}`}
            />
            <span
              className={`text-[11px] ${i === current ? 'font-semibold text-slate-800' : 'text-slate-500'}`}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
