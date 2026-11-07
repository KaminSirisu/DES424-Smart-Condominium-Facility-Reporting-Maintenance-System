import { useSyncExternalStore } from 'react';
import { MOCK_EVENTS, MOCK_TICKETS } from './mockTickets';
import type {
  Priority,
  StaffProfile,
  Ticket,
  TicketEvent,
  TicketStatus,
} from './types';

// In-memory mock store. Each action mirrors one API endpoint (named above it);
// replace the bodies with fetch calls when the backend exists.
type StoreState = { tickets: Ticket[]; events: TicketEvent[] };

let state: StoreState = { tickets: MOCK_TICKETS, events: MOCK_EVENTS };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

function setState(next: StoreState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function useStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

const OPEN_STATUSES: TicketStatus[] = ['RECEIVED', 'ASSIGNED', 'IN_PROGRESS'];

const fakeNetworkDelay = () =>
  new Promise((resolve) => setTimeout(resolve, 400));

export class TicketActionError extends Error {}

function findTicket(ticketId: string): Ticket {
  const ticket = state.tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new TicketActionError('This job no longer exists.');
  return ticket;
}

function assertSameTeam(ticket: Ticket, staff: StaffProfile) {
  if (!staff.teamId || ticket.teamId !== staff.teamId) {
    throw new TicketActionError('This job belongs to another team.');
  }
}

type NewEvent = Omit<TicketEvent, 'id' | 'ticketId' | 'occurredAt'>;

function makeEvent(
  ticketId: string,
  occurredAt: string,
  event: NewEvent,
): TicketEvent {
  return { id: `evt_${crypto.randomUUID()}`, ticketId, occurredAt, ...event };
}

function saveTicket(updated: Ticket, event: NewEvent) {
  setState({
    tickets: state.tickets.map((t) => (t.id === updated.id ? updated : t)),
    events: [...state.events, makeEvent(updated.id, updated.updatedAt, event)],
  });
}

// ---- Hooks ----

export function useTeamTickets(teamId: string | undefined): Ticket[] {
  return useStore().tickets.filter((ticket) => ticket.teamId === teamId);
}

export function useTicket(ticketId: string | undefined): Ticket | undefined {
  return useStore().tickets.find((ticket) => ticket.id === ticketId);
}

// GET /tickets/{id}/events
export function useTicketEvents(ticketId: string): TicketEvent[] {
  return useStore()
    .events.filter((event) => event.ticketId === ticketId)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

// GET /tickets/{id}/duplicates (proposed). Mock rule: same team, same location
// text, still open. The real matching rule is not approved yet.
export function useDuplicateCandidates(ticket: Ticket | undefined): Ticket[] {
  const { tickets } = useStore();
  if (!ticket) return [];
  return tickets.filter(
    (t) =>
      t.id !== ticket.id &&
      t.teamId === ticket.teamId &&
      t.location === ticket.location &&
      OPEN_STATUSES.includes(t.status),
  );
}

// ---- Actions ----

// PATCH /tickets/{id}/status { status: 'IN_PROGRESS' }
export async function startWork(
  ticketId: string,
  staff: StaffProfile,
): Promise<void> {
  await fakeNetworkDelay();
  const ticket = findTicket(ticketId);
  assertSameTeam(ticket, staff);
  if (ticket.status !== 'ASSIGNED') {
    throw new TicketActionError('This job has already been started.');
  }
  const now = new Date().toISOString();
  saveTicket(
    { ...ticket, status: 'IN_PROGRESS', updatedAt: now },
    {
      kind: 'STATUS_CHANGED',
      actorType: 'STAFF',
      actorStaffId: staff.id,
      fromStatus: 'ASSIGNED',
      toStatus: 'IN_PROGRESS',
      repairCycle: ticket.repairCycle,
    },
  );
}

// POST /uploads { purpose: 'REPAIR_PROOF' }, then PUT the file to the returned S3 URL.
export async function uploadRepairProof(file: File): Promise<string> {
  await fakeNetworkDelay();
  if (!file.type.startsWith('image/')) {
    throw new TicketActionError('Please choose an image file.');
  }
  return `upl_${crypto.randomUUID()}`;
}

// PATCH /tickets/{id}/status { status: 'DONE', proofPhotoUploadId }
export async function markDone(
  ticketId: string,
  staff: StaffProfile,
  proofPhotoUploadId: string,
): Promise<void> {
  await fakeNetworkDelay();
  const ticket = findTicket(ticketId);
  assertSameTeam(ticket, staff);
  if (ticket.status !== 'IN_PROGRESS') {
    throw new TicketActionError('Start work before completing this job.');
  }
  const now = new Date().toISOString();
  saveTicket(
    {
      ...ticket,
      status: 'DONE',
      completedAt: now,
      updatedAt: now,
      photos: [
        ...ticket.photos,
        {
          id: proofPhotoUploadId,
          purpose: 'REPAIR_PROOF',
          addedAt: now,
          repairCycle: ticket.repairCycle,
        },
      ],
    },
    {
      kind: 'STATUS_CHANGED',
      actorType: 'STAFF',
      actorStaffId: staff.id,
      fromStatus: 'IN_PROGRESS',
      toStatus: 'DONE',
      repairCycle: ticket.repairCycle,
      proofPhotoId: proofPhotoUploadId,
    },
  );
}

// PATCH /tickets/{id}/priority { priority, reason? }
export async function setPriority(
  ticketId: string,
  staff: StaffProfile,
  priority: Priority,
  reason?: string,
): Promise<void> {
  await fakeNetworkDelay();
  const ticket = findTicket(ticketId);
  assertSameTeam(ticket, staff);
  if (!OPEN_STATUSES.includes(ticket.status)) {
    throw new TicketActionError('This job is already closed.');
  }
  const changing = priority !== ticket.priority;
  const note = reason?.trim();
  if (changing && !note) {
    throw new TicketActionError(
      'Please give a reason for changing the priority.',
    );
  }
  const now = new Date().toISOString();
  saveTicket(
    { ...ticket, priority, prioritySetBy: 'STAFF', updatedAt: now },
    {
      kind: changing ? 'PRIORITY_CHANGED' : 'PRIORITY_CONFIRMED',
      actorType: 'STAFF',
      actorStaffId: staff.id,
      fromPriority: ticket.priority,
      toPriority: priority,
      note,
    },
  );
}

// POST /tickets/{id}/merge { sourceTicketIds }
export async function mergeTickets(
  canonicalId: string,
  staff: StaffProfile,
  sourceTicketIds: string[],
): Promise<void> {
  await fakeNetworkDelay();
  const canonical = findTicket(canonicalId);
  const sources = sourceTicketIds.map(findTicket);
  [canonical, ...sources].forEach((ticket) => assertSameTeam(ticket, staff));
  if (sources.some((s) => !OPEN_STATUSES.includes(s.status))) {
    throw new TicketActionError('One of these jobs is already closed.');
  }
  const now = new Date().toISOString();
  setState({
    tickets: state.tickets.map((t) =>
      sourceTicketIds.includes(t.id)
        ? {
            ...t,
            status: 'MERGED',
            mergedIntoTicketId: canonicalId,
            updatedAt: now,
          }
        : t,
    ),
    events: [
      ...state.events,
      ...sources.map((s) =>
        makeEvent(s.id, now, {
          kind: 'MERGED',
          actorType: 'STAFF',
          actorStaffId: staff.id,
          fromStatus: s.status,
          toStatus: 'MERGED',
          note: `Merged into #${canonicalId}`,
        }),
      ),
      makeEvent(canonicalId, now, {
        kind: 'DUPLICATES_MERGED',
        actorType: 'STAFF',
        actorStaffId: staff.id,
        note: `Merged in #${sourceTicketIds.join(', #')}`,
      }),
    ],
  });
}
