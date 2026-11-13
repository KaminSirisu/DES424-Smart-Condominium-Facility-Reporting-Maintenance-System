import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { MapPin, X } from 'lucide-react';
import { api, errorMessage } from '../services/api';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import { eventLabel } from '../lib/events';
import { PRIORITIES, TEAMS } from '../lib/constants';
import {
  actorLabel,
  formatDateTime,
  prioritySetByLabel,
  shortId,
  slaLeft,
  teamLabel,
} from '../lib/format';
import { PriorityBadge, StatusBadge } from './Badges';
import PhotoPreview from './PhotoPreview';
import type { Priority, TicketEvent } from '../services/types';
import { DrawerSkeleton, TimelineSkeleton } from './Skeleton';

type Props = { ticketId: string; onClose: () => void; onSaved: () => void };

/** Who to show next to an event. Reporter and SLA/system events need no name. */
function eventActor(e: TicketEvent): string | null {
  if (e.actorType === 'REPORTER') return 'Resident';
  if (e.kind === 'TRIAGED' || e.kind.startsWith('SLA')) return null; // already in the label
  return e.actorType === 'STAFF' ? actorLabel(e) : null;
}

const field =
  'rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50';

export default function TicketDrawer({ ticketId, onClose, onSaved }: Props) {
  const now = useNow();
  const ticket = useApi(() => api.getTicket(ticketId), ticketId);
  const events = useApi(() => api.listEvents(ticketId), ticketId);

  const [priority, setPriority] = useState<Priority | ''>('');
  const [teamId, setTeamId] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset the form whenever a (new or reloaded) ticket arrives.
  const t = ticket.data;
  useEffect(() => {
    setPriority(t?.priority ?? '');
    setTeamId(t?.teamId ?? '');
    setReason('');
    setSaveError(null);
  }, [t]);

  // Escape closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canEditPriority =
    t?.status === 'ASSIGNED' || t?.status === 'IN_PROGRESS';
  const canReassign = t?.status === 'ASSIGNED';
  const priorityChanged = !!t && priority !== '' && priority !== t.priority;
  const teamChanged = !!t && teamId !== '' && teamId !== t.teamId;
  const hasChanges = priorityChanged || teamChanged;

  async function handleSave() {
    if (!t || !hasChanges) return;
    if (!reason.trim()) {
      setSaveError('Please give a reason for the change.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (teamChanged) await api.reassign(t.id, teamId, reason.trim());
      if (priorityChanged && priority)
        await api.setPriority(t.id, priority, reason.trim());
      ticket.reload();
      events.reload();
      onSaved();
    } catch (e) {
      setSaveError(errorMessage(e));
      ticket.reload(); // the first call may have worked; show the real state
    } finally {
      setSaving(false);
    }
  }

  const defectPhoto = t?.photos.find((p) => p.purpose === 'DEFECT');
  const sla = t ? slaLeft(t, now) : null;

  return (
    <>
      <div className="fixed inset-0 z-10 bg-black/30" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-20 flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <h2 className="text-xl font-bold">{shortId(ticketId)}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"
          >
            <X size={16} />
          </button>
        </div>

        {ticket.error && <p className="text-sm text-red-600">{ticket.error}</p>}
        {!t && !ticket.error && <DrawerSkeleton />}

        {t && (
          <>
            <div>
              <p className="text-slate-800">{t.description}</p>
              <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                <MapPin size={12} className="text-red-500" /> {t.location}
              </p>
            </div>

            {defectPhoto && (
              <PhotoPreview
                ticketId={t.id}
                photoId={defectPhoto.id}
                alt="Reporter photo"
              />
            )}

            {t.priority && (
              <div className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs">
                <b>Set by {prioritySetByLabel(t, events.data?.items)}</b> ·{' '}
                {teamLabel(t.teamId)} · {t.priority}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-sm">
              Status <StatusBadge status={t.status} /> ·{' '}
              <PriorityBadge priority={t.priority} />
              {sla && (
                <span className={sla.overdue ? 'text-red-600' : ''}>
                  · SLA {sla.text}
                </span>
              )}
            </div>

            {t.status === 'RECEIVED' ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
                The AI could not classify this report, so it has no team yet.{' '}
                <Link
                  to="/triage"
                  className="font-medium text-orange-600 underline"
                >
                  Assign it on the Needs triage page →
                </Link>
              </div>
            ) : (
              <section className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4">
                <h3 className="font-bold">Assigned team</h3>

                <label className="flex flex-col gap-1 text-xs text-slate-500">
                  Maintenance team{' '}
                  {!canReassign && '(can change only before work starts)'}
                  <select
                    value={teamId}
                    disabled={!canReassign || saving}
                    onChange={(e) => setTeamId(e.target.value)}
                    className={field}
                  >
                    {TEAMS.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-xs text-slate-500">
                  Priority
                  <select
                    value={priority}
                    disabled={!canEditPriority || saving}
                    onChange={(e) => setPriority(e.target.value as Priority)}
                    className={field}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>

                {hasChanges && (
                  <label className="flex flex-col gap-1 text-xs text-slate-500">
                    Reason (saved in the activity log)
                    <input
                      value={reason}
                      maxLength={1000}
                      disabled={saving}
                      onChange={(e) => setReason(e.target.value)}
                      className={field}
                    />
                  </label>
                )}

                {saveError && (
                  <p className="text-xs text-red-600">{saveError}</p>
                )}

                {(canEditPriority || canReassign) && (
                  <button
                    onClick={handleSave}
                    disabled={!hasChanges || saving}
                    className="self-start rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
              </section>
            )}

            <section>
              <h3 className="mb-3 font-bold">Activity</h3>
              {!events.data && !events.error && <TimelineSkeleton />}
              {events.error && (
                <p className="text-sm text-red-600">{events.error}</p>
              )}
              <ol className="flex flex-col gap-4 border-l border-slate-200 pl-4">
                {events.data?.items.map((e) => {
                  const who = eventActor(e);
                  return (
                    <li key={e.id} className="relative">
                      <span
                        className={`absolute -left-5.25 top-1 h-2.5 w-2.5 rounded-full ${
                          e.kind.startsWith('SLA')
                            ? 'bg-red-500'
                            : 'bg-green-500'
                        }`}
                      />
                      <p className="text-sm font-medium">
                        {eventLabel(e)}
                        {who && (
                          <span className="font-normal text-slate-500">
                            {' '}
                            · {who}
                          </span>
                        )}
                      </p>
                      {e.note && (
                        <p className="text-xs text-slate-500">“{e.note}”</p>
                      )}
                      <p className="text-xs text-slate-400">
                        {formatDateTime(e.occurredAt)}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </section>
          </>
        )}
      </aside>
    </>
  );
}
