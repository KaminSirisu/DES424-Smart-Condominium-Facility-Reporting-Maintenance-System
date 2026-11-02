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
  suggestedPriority?: Priority;
  priority?: Priority;
  teamId?: string;
  acceptedByStaffId?: string;
  acceptedAt?: string;
  deadlineAt?: string;
  completedAt?: string;
  mergedIntoTicketId?: string;
  createdAt: string;
  updatedAt: string;
};
