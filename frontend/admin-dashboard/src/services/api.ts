import { clearSession, getSession } from './session';
import type {
  DashboardHistory,
  DashboardSummary,
  ManagedAccount,
  MfaChallenge,
  MfaEnrollment,
  Page,
  PhotoAccess,
  Priority,
  StaffSession,
  Ticket,
  TicketEvent,
  TicketStatus,
  UploadGrant,
} from './types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(
  /\/+$/,
  '',
);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    if (body.error?.message) {
      return new ApiError(
        response.status,
        body.error.code ?? 'ERROR',
        body.error.message,
      );
    }
  } catch {
    /* not JSON */
  }
  return new ApiError(
    response.status,
    'HTTP_ERROR',
    `Request failed with HTTP ${response.status}.`,
  );
}

type Options = {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  auth?: boolean;
  headers?: Record<string, string>;
};

async function request<T>(
  path: string,
  {
    method = 'GET',
    body,
    auth = true,
    headers: extraHeaders = {},
  }: Options = {},
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';

  if (auth) {
    const session = getSession();
    if (!session) {
      window.location.assign('/login');
      throw new ApiError(401, 'NO_SESSION', 'Please log in.');
    }
    headers.authorization = `Bearer ${session.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'Cannot reach the server. Check your connection.',
    );
  }
  if (response.status === 401 && auth) {
    clearSession();
    window.location.assign('/login');
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

const id = (value: string) => encodeURIComponent(value);

export const api = {
  // --- auth (no token yet) ---
  login: (email: string, password: string) =>
    request<StaffSession | MfaChallenge>('/auth/staff/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  verifyMfa: (challengeToken: string, code: string) =>
    request<StaffSession>('/auth/staff/mfa/verify', {
      method: 'POST',
      body: { challengeToken, code },
      auth: false,
    }),
  enrollMfa: (challengeToken: string) =>
    request<MfaEnrollment>('/auth/staff/mfa/enroll', {
      method: 'POST',
      body: { challengeToken },
      auth: false,
    }),
  confirmMfa: (challengeToken: string, code: string) =>
    request<StaffSession>('/auth/staff/mfa/confirm', {
      method: 'POST',
      body: { challengeToken, code },
      auth: false,
    }),

  // --- dashboard ---
  getSummary: () => request<DashboardSummary>('/dashboard/summary'),
  getHistoryPage: (cursor?: string) => {
    const qs = new URLSearchParams({ limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    return request<DashboardHistory>(`/dashboard/history?${qs}`);
  },

  // --- tickets ---
  getTicket: (ticketId: string) => request<Ticket>(`/tickets/${id(ticketId)}`),
  listEvents: (ticketId: string) =>
    request<Page<TicketEvent>>(`/tickets/${id(ticketId)}/events?limit=100`),
  getPhotoAccess: (ticketId: string, photoId: string) =>
    request<PhotoAccess>(
      `/tickets/${id(ticketId)}/photos/${id(photoId)}/access`,
    ),
  setPriority: (ticketId: string, priority: Priority, reason?: string) =>
    request<Ticket>(`/tickets/${id(ticketId)}/priority`, {
      method: 'PATCH',
      body: reason ? { priority, reason } : { priority },
    }),
  reassign: (ticketId: string, teamId: string, reason: string) =>
    request<Ticket>(`/tickets/${id(ticketId)}/assignment`, {
      method: 'PATCH',
      body: { teamId, reason },
    }),

  // --- manual triage (tickets the AI could not classify stay RECEIVED) ---
  listUntriaged: (cursor?: string) => {
    const qs = new URLSearchParams({ status: 'RECEIVED', limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    return request<Page<Ticket>>(`/tickets?${qs}`);
  },
  triage: (
    ticketId: string,
    teamId: string,
    priority: Priority,
    reason?: string,
  ) =>
    request<Ticket>(`/tickets/${id(ticketId)}/triage`, {
      method: 'PATCH',
      body: reason ? { teamId, priority, reason } : { teamId, priority },
    }),

  // --- staff ---
  listStaffAccounts: () =>
    request<{ items: ManagedAccount[] }>('/staff-accounts'),

  // --- technician (staff UI) ---
  listTeamTicketsPage: (statuses: TicketStatus[], cursor?: string) => {
    const qs = new URLSearchParams({ limit: '50' });
    statuses.forEach((s) => qs.append('status', s));
    if (cursor) qs.set('cursor', cursor);
    return request<Page<Ticket>>(`/tickets?${qs}`);
  },
  listDuplicates: (ticketId: string) =>
    request<Page<Ticket>>(`/tickets/${id(ticketId)}/duplicates?limit=20`),
  setStatus: (
    ticketId: string,
    status: 'IN_PROGRESS' | 'DONE',
    proofPhotoUploadId?: string,
  ) =>
    request<Ticket>(`/tickets/${id(ticketId)}/status`, {
      method: 'PATCH',
      body: proofPhotoUploadId ? { status, proofPhotoUploadId } : { status },
    }),
  createRepairProofUpload: (file: File) =>
    request<UploadGrant>('/uploads', {
      method: 'POST',
      body: {
        purpose: 'REPAIR_PROOF',
        contentType: file.type,
        sizeBytes: file.size,
      },
    }),
  merge: (
    ticketId: string,
    sourceTicketIds: string[],
    idempotencyKey: string,
  ) =>
    request<Ticket>(`/tickets/${id(ticketId)}/merge`, {
      method: 'POST',
      body: { sourceTicketIds },
      headers: { 'idempotency-key': idempotencyKey },
    }),
};

/**
 * Every ticket of the report period (all teams, all statuses), newest first.
 * The history endpoint pages at 100; we follow nextCursor up to maxPages.
 */
export async function getAllHistory(maxPages = 10): Promise<DashboardHistory> {
  let page = await api.getHistoryPage();
  const items = [...page.items];
  for (let i = 1; i < maxPages && page.nextCursor; i++) {
    page = await api.getHistoryPage(page.nextCursor);
    items.push(...page.items);
  }
  return { ...page, items };
}

/** All of the team's tickets with these statuses. A page can be short while nextCursor is set, so follow it. */
export async function listTeamTickets(
  statuses: TicketStatus[],
  maxPages = 5,
): Promise<Ticket[]> {
  let page = await api.listTeamTicketsPage(statuses);
  const items = [...page.items];
  for (let i = 1; i < maxPages && page.nextCursor; i++) {
    page = await api.listTeamTicketsPage(statuses, page.nextCursor);
    items.push(...page.items);
  }
  return items;
}

const PROOF_TYPES = ['image/jpeg', 'image/png'];
const MAX_PROOF_BYTES = 10 * 1024 * 1024;

/** Uploads a proof-of-repair photo straight to S3; returns the uploadId for PATCH /status DONE. */
export async function uploadRepairProof(file: File): Promise<string> {
  if (!PROOF_TYPES.includes(file.type)) {
    throw new ApiError(422, 'BAD_TYPE', 'Please choose a JPEG or PNG photo.');
  }
  if (file.size > MAX_PROOF_BYTES) {
    throw new ApiError(422, 'TOO_LARGE', 'The photo must be 10 MB or smaller.');
  }
  const grant = await api.createRepairProofUpload(file);
  let response: Response;
  try {
    response = await fetch(grant.uploadUrl, {
      method: grant.method,
      headers: grant.headers,
      body: file,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Upload failed. Check your connection.');
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      'UPLOAD_FAILED',
      'Upload failed. Please try again.',
    );
  }
  return grant.uploadId;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'Your account is not allowed to do this.';
    if (error.status === 429)
      return 'Too many requests. Please wait and try again.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
