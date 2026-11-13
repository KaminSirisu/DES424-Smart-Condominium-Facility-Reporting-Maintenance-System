export type TicketStatus =
  'RECEIVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'DONE' | 'MERGED';
export type Priority = 'CRITICAL' | 'MEDIUM' | 'LOW';
export type TeamId =
  | 'ELECTRICAL'
  | 'PLUMBING'
  | 'HVAC'
  | 'CLEANING_SANITATION'
  | 'BUILDING_EQUIPMENT';

export type TicketPhoto = {
  id: string;
  purpose: 'DEFECT' | 'REPAIR_PROOF';
  addedAt: string;
  repairCycle?: number;
};

export type Ticket = {
  id: string;
  location: string;
  description: string;
  status: TicketStatus;
  repairCycle: number;
  category?: string;
  priority?: Priority;
  prioritySetBy?: 'AI' | 'STAFF';
  teamId?: string;
  photos: TicketPhoto[];
  deadlineAt?: string;
  completedAt?: string;
  mergedIntoTicketId?: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketEvent = {
  id: string;
  ticketId: string;
  kind: string;
  occurredAt: string;
  actorType?: 'REPORTER' | 'STAFF' | 'SYSTEM';
  actorStaffId?: string;
  /** Team of the technician who acted. Not set for a manager. */
  actorTeamId?: string;
  fromStatus?: TicketStatus;
  toStatus?: TicketStatus;
  fromPriority?: Priority;
  toPriority?: Priority;
  fromTeamId?: string;
  toTeamId?: string;
  repairCycle?: number;
  proofPhotoId?: string;
  note?: string;
};

export type Page<T> = { items: T[]; nextCursor?: string };

export type DashboardSummary = {
  openCount: number;
  overdueCount?: number;
  countsByStatus: Record<TicketStatus, number>;
  teamWorkloads: { teamId: string; openCount: number }[];
  generatedAt: string;
};

export type HistoryEntry = {
  ticket: Ticket;
  completionCount: number;
  reopenCount: number;
  lastCompletedAt?: string;
};

export type DashboardHistory = {
  items: HistoryEntry[];
  summary: {
    totalTickets: number;
    countsByStatus: Record<string, number>;
    countsByPriority: Record<string, number>;
    countsByTeam: Record<string, number>;
    locationBreakdown: {
      location: string;
      reportedCount: number;
      completedCount: number;
    }[];
    completionCount: number;
    reopenCount: number;
  };
  nextCursor?: string;
  generatedAt: string;
};

export type StaffProfile = {
  id: string;
  name: string;
  role: 'TECHNICIAN' | 'MANAGER';
  teamId?: string;
  teamName?: string;
};
export type StaffSession = {
  accessToken: string;
  expiresInSeconds: number;
  staff: StaffProfile;
};
export type MfaChallenge = {
  mfaRequired: true;
  mfaEnrolled: boolean;
  challengeToken: string;
  expiresInSeconds: number;
};
export type MfaEnrollment = { secret: string; otpauthUri: string };
export type PhotoAccess = { url: string; expiresAt: string };

export type ManagedAccount = {
  accountId: string;
  email: string;
  role: 'TECHNICIAN' | 'MANAGER';
  teamId?: string;
  displayName: string;
  isActive: boolean;
  mfaEnabled?: boolean;
  lockedUntil?: string;
  lastLoginAt?: string;
  passwordChangedAt: string;
  createdAt: string;
};

export type UploadGrant = {
  uploadId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
};
