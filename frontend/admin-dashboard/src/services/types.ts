export type TicketStatus =
  'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'DONE' | 'MERGED';
export type Priority = 'CRITICAL' | 'MEDIUM' | 'LOW';
export type StaffRole = 'TECHNICIAN' | 'MANAGER';

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
  priority?: Priority;
};
