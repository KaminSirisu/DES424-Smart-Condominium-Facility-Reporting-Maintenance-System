import { useSyncExternalStore } from 'react';
import { MOCK_TICKETS } from './mockTickets';
import type { StaffProfile, Ticket } from './types';

// In-memory mock store. Each action below mirrors one API endpoint;
// replace their bodies with fetch calls when the backend exists.
let tickets: Ticket[] = MOCK_TICKETS;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return tickets;
}

function saveTicket(updated: Ticket) {
  tickets = tickets.map((ticket) =>
    ticket.id === updated.id ? updated : ticket,
  );
  listeners.forEach((listener) => listener());
}

function findTicket(ticketId: string): Ticket {
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new TicketActionError('This job no longer exists.');
  return ticket;
}

const fakeNetworkDelay = () =>
  new Promise((resolve) => setTimeout(resolve, 400));

export class TicketActionError extends Error {}

function useAllTickets(): Ticket[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useTeamTickets(teamId: string | undefined): Ticket[] {
  return useAllTickets().filter((ticket) => ticket.teamId === teamId);
}

export function useTicket(ticketId: string | undefined): Ticket | undefined {
  return useAllTickets().find((ticket) => ticket.id === ticketId);
}

// POST /tickets/{id}/accept, then PATCH /tickets/{id}/status { status: 'IN_PROGRESS' }
export async function startWork(
  ticketId: string,
  staff: StaffProfile,
): Promise<void> {
  await fakeNetworkDelay();
  const ticket = findTicket(ticketId);
  if (ticket.teamId !== staff.teamId) {
    throw new TicketActionError('This job belongs to another team.');
  }
  if (ticket.status !== 'ASSIGNED') {
    throw new TicketActionError('This job has already been started.');
  }
  const now = new Date().toISOString();
  saveTicket({
    ...ticket,
    status: 'IN_PROGRESS',
    acceptedByStaffId: staff.id,
    acceptedAt: now,
    updatedAt: now,
  });
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
  if (ticket.status !== 'IN_PROGRESS') {
    throw new TicketActionError('Start work before completing this job.');
  }
  if (ticket.acceptedByStaffId !== staff.id) {
    throw new TicketActionError(
      'Only the technician who started this job can complete it.',
    );
  }
  const now = new Date().toISOString();
  saveTicket({
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
  });
}
