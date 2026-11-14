import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../frontend/liff-app/src/utils/liff', () => ({
  getLineIdToken: vi.fn(async () => 'id-token-123'),
}));

import {
  API_BASE_URL,
  ApiError,
  apiErrorMessage,
  getPhotoAccess,
  getTicket,
  reopenTicket,
  type Ticket,
} from '../../frontend/liff-app/src/services/api';
import {
  canReopen,
  defectPhoto,
  latestProofPhoto,
  reopenDeadline,
  shortId,
  teamLabel,
} from '../../frontend/liff-app/src/lib/format';
import {
  parseRoute,
  reopenPath,
  ticketPath,
} from '../../frontend/liff-app/src/lib/router';

const DAY = 24 * 60 * 60 * 1000;

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tkt_a429813a00',
    location: 'Building B toilet',
    description: 'Toilet keeps running',
    status: 'DONE',
    repairCycle: 1,
    photos: [],
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    completedAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('getTicket', () => {
  it('GETs the ticket with the LINE token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ticket()));

    await expect(getTicket('tkt_a429813a00')).resolves.toMatchObject({
      id: 'tkt_a429813a00',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/tickets/tkt_a429813a00`);
    expect(init.method).toBeUndefined();
    expect(init.headers.authorization).toBe('Bearer id-token-123');
  });

  it('encodes the ticket ID in the path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ticket()));
    await getTicket('a/b?c');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE_URL}/tickets/a%2Fb%3Fc`,
    );
  });

  it('throws an ApiError on 404', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: 'Ticket not found.' },
      }),
    );
    await expect(getTicket('tkt_x')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('getPhotoAccess', () => {
  it('GETs the photo access link', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { url: 'https://s3/photo.jpg', expiresAt: 'x' }),
    );

    await expect(getPhotoAccess('tkt_1', 'ph_1')).resolves.toEqual({
      url: 'https://s3/photo.jpg',
      expiresAt: 'x',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/tickets/tkt_1/photos/ph_1/access`);
    expect(init.headers.authorization).toBe('Bearer id-token-123');
  });

  it('throws on 403', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'No.' } }),
    );
    await expect(getPhotoAccess('tkt_1', 'ph_1')).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe('reopenTicket', () => {
  it('POSTs the trimmed reason with the Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, ticket({ status: 'ASSIGNED', repairCycle: 2 })),
    );

    const result = await reopenTicket(
      'tkt_1',
      '  Still leaking  ',
      'key-12345678',
    );

    expect(result.status).toBe('ASSIGNED');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/tickets/tkt_1/reopen`);
    expect(init.method).toBe('POST');
    expect(init.headers['idempotency-key']).toBe('key-12345678');
    expect(init.headers.authorization).toBe('Bearer id-token-123');
    expect(JSON.parse(init.body)).toEqual({ reason: 'Still leaking' });
  });

  it('sends an empty object when there is no reason', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, ticket()));
    await reopenTicket('tkt_1', '   ', 'key-12345678');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
  });

  it('passes on the 409 message when the window has closed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: {
          code: 'REOPEN_WINDOW_CLOSED',
          message: 'A ticket can be reopened within 7 days of its completion.',
        },
      }),
    );

    const error = await reopenTicket('tkt_1', '', 'key-12345678').catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ status: 409, code: 'REOPEN_WINDOW_CLOSED' });
    expect(apiErrorMessage(error)).toBe(
      'A ticket can be reopened within 7 days of its completion.',
    );
  });
});

describe('apiErrorMessage', () => {
  it('explains a 404 in reporter terms', () => {
    expect(apiErrorMessage(new ApiError(404, 'NOT_FOUND', 'x'))).toMatch(
      /another LINE account/,
    );
  });
});

describe('parseRoute', () => {
  it.each([
    ['/', { name: 'report' }],
    ['', { name: 'report' }],
    ['/tickets', { name: 'report' }],
    ['/tickets/tkt_1', { name: 'ticket', ticketId: 'tkt_1' }],
    ['/tickets/tkt_1/', { name: 'ticket', ticketId: 'tkt_1' }],
    ['/tickets/tkt_1/reopen', { name: 'reopen', ticketId: 'tkt_1' }],
    ['/tickets/tkt_1/reopen/', { name: 'reopen', ticketId: 'tkt_1' }],
    ['/tickets/a%2Fb', { name: 'ticket', ticketId: 'a/b' }],
    ['/tickets/tkt_1/other', { name: 'report' }],
    ['/tickets/%E0%A4%A', { name: 'report' }],
    ['/something', { name: 'report' }],
  ])('%s', (path, expected) => {
    expect(parseRoute(path)).toEqual(expected);
  });

  it('round-trips the paths it builds', () => {
    expect(parseRoute(ticketPath('a/b'))).toEqual({
      name: 'ticket',
      ticketId: 'a/b',
    });
    expect(parseRoute(reopenPath('tkt_1'))).toEqual({
      name: 'reopen',
      ticketId: 'tkt_1',
    });
  });
});

describe('format helpers', () => {
  it('shortId matches the LINE message reference', () => {
    expect(shortId('tkt_a429813a00ff')).toBe('#A429813A');
  });

  it('teamLabel', () => {
    expect(teamLabel('PLUMBING')).toBe('Plumbing');
    expect(teamLabel('NEW_TEAM')).toBe('NEW_TEAM');
    expect(teamLabel(undefined)).toBeUndefined();
  });

  it('reopen window is 7 days after completion', () => {
    const t = ticket();
    const done = Date.parse(t.completedAt!);
    expect(reopenDeadline(t)?.getTime()).toBe(done + 7 * DAY);
    expect(canReopen(t, done + 7 * DAY)).toBe(true);
    expect(canReopen(t, done + 7 * DAY + 1)).toBe(false);
  });

  it('falls back to updatedAt when completedAt is missing', () => {
    const t = ticket({ completedAt: undefined });
    expect(reopenDeadline(t)?.getTime()).toBe(
      Date.parse(t.updatedAt) + 7 * DAY,
    );
  });

  it('only a DONE ticket can be reopened', () => {
    for (const status of [
      'RECEIVED',
      'ASSIGNED',
      'IN_PROGRESS',
      'MERGED',
    ] as const) {
      expect(canReopen(ticket({ status }), Date.parse('2026-11-12'))).toBe(
        false,
      );
    }
  });

  it('picks the defect photo and the proof of the current cycle', () => {
    const t = ticket({
      repairCycle: 2,
      photos: [
        { id: 'd', purpose: 'DEFECT', addedAt: '' },
        { id: 'p1', purpose: 'REPAIR_PROOF', addedAt: '', repairCycle: 1 },
        { id: 'p2', purpose: 'REPAIR_PROOF', addedAt: '', repairCycle: 2 },
        { id: 'p1b', purpose: 'REPAIR_PROOF', addedAt: '', repairCycle: 1 },
      ],
    });
    expect(defectPhoto(t)?.id).toBe('d');
    expect(latestProofPhoto(t)?.id).toBe('p2');
  });

  it('falls back to the latest earlier proof after a reopen', () => {
    const t = ticket({
      status: 'ASSIGNED',
      repairCycle: 2,
      photos: [
        { id: 'p1', purpose: 'REPAIR_PROOF', addedAt: '', repairCycle: 1 },
      ],
    });
    expect(latestProofPhoto(t)?.id).toBe('p1');
    expect(latestProofPhoto(ticket())).toBeUndefined();
  });
});
