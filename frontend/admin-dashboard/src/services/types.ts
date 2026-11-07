export type TicketStatus =
  'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'DONE' | 'MERGED';
export type Priority = 'CRITICAL' | 'MEDIUM' | 'LOW';
export type StaffRole = 'TECHNICIAN' | 'MANAGER';
export type PhotoPurpose = 'DEFECT' | 'REPAIR_PROOF';

export type TicketPhoto = {
  id: string;
  purpose: PhotoPurpose;
  addedAt: string;
  repairCycle?: number;
};

export type StaffProfile = {
  id: string;
  name: string;
  role: StaffRole;
  teamId?: string;
  teamName?: string;
};

export type Ticket = {
  id: string;
  description: string;
  location: string;
  status: TicketStatus;
  repairCycle: number;
  photos: TicketPhoto[];
  category?: string;
  priority?: Priority;
  prioritySetBy?: PrioritySetBy;
  teamId?: string;
  deadlineAt?: string;
  completedAt?: string;
  mergedIntoTicketId?: string;
  createdAt: string;
  updatedAt: string;
};

export type PrioritySetBy = 'AI' | 'STAFF';

export type TicketEvent = {
  id: string;
  ticketId: string;
  kind: string;
  occurredAt: string;
  actorType?: 'REPORTER' | 'STAFF' | 'SYSTEM';
  actorStaffId?: string;
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
  fromPriority?: Priority;
  toPriority?: Priority;
  repairCycle?: number;
  proofPhotoId?: string;
  note?: string;
};
