import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketRecord } from '../../backend/src/tickets/types';
import type { LineSender } from '../../backend/src/notifications/line-messenger';
import {
  LinePushError,
  retryKeyFor,
} from '../../backend/src/notifications/line-messenger';
import {
  LINE_KINDS,
  createLineChannel,
  flexOptionsFromEnv,
} from '../../backend/src/notifications/line-notification';

const event = (kind: string, toStatus?: string) => ({
  ticketId: 'tkt_1',
  eventId: `tkt_1_${kind.toLowerCase()}`,
  kind,
  ...(toStatus ? { toStatus } : {}),
});

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 2,
    reporterLineUserId: 'Uaaa',
    teamId: 'PLUMBING',
    createdAt: '2026-10-29T03:00:00.000Z',
    updatedAt: '2026-10-29T03:01:00.000Z',
    ...overrides,
  };
}

function setup(push = vi.fn().mockResolvedValue(undefined)) {
  const sender: LineSender = { push };
  const channel = createLineChannel({
    sender,
    listReporters: vi.fn().mockResolvedValue(['Uaaa', 'Ubbb']),
    options: () => ({
      securityPhone: '02-123-4567',
      liffUrl: 'https://liff.line.me/1234567890-AbCdEfGh',
    }),
  });
  return { channel, push };
}

describe('LINE reporter channel', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is triggered by the receipt, assignment and status events', () => {
    const { channel } = setup();
    expect(channel.name).toBe('LINE_REPORTER');
    expect(channel.kinds).toEqual(LINE_KINDS);
    expect([...channel.kinds]).toEqual([
      'TICKET_CREATED',
      'TRIAGED',
      'STATUS_CHANGED',
    ]);
  });

  it('messages every reporter of the ticket', async () => {
    const { channel } = setup();
    await expect(channel.recipients(ticket())).resolves.toEqual([
      'Uaaa',
      'Ubbb',
    ]);
  });

  it('sends the receipt for a created ticket, with a stable retry key', async () => {
    const { channel, push } = setup();

    await expect(
      channel.send(ticket(), 'Ubbb', event('TICKET_CREATED')),
    ).resolves.toBe(true);

    const [to, messages, retryKey] = push.mock.calls[0];
    expect(to).toBe('Ubbb');
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('flex');
    expect(messages[0].altText).toContain('Report received');
    expect(JSON.stringify(messages[0])).toContain('021234567');
    expect(retryKey).toBe(retryKeyFor('tkt_1_ticket_created', 'Ubbb'));
  });

  it('sends the assignment notice for a triaged ticket', async () => {
    const { channel, push } = setup();

    await channel.send(ticket(), 'Uaaa', event('TRIAGED'));

    expect(push.mock.calls[0][1][0].altText).toContain(
      'assigned to the Plumbing team',
    );
  });

  it('sends the work started notice when the status became IN_PROGRESS', async () => {
    const { channel, push } = setup();

    await expect(
      channel.send(
        ticket({ status: 'IN_PROGRESS' }),
        'Uaaa',
        event('STATUS_CHANGED', 'IN_PROGRESS'),
      ),
    ).resolves.toBe(true);

    expect(push.mock.calls[0][1][0].altText).toContain('Work started');
    expect(push.mock.calls[0][2]).toBe(
      retryKeyFor('tkt_1_status_changed', 'Uaaa'),
    );
  });

  it('sends the completion notice with Re-open when the status became DONE', async () => {
    const { channel, push } = setup();

    await expect(
      channel.send(
        ticket({ status: 'DONE' }),
        'Uaaa',
        event('STATUS_CHANGED', 'DONE'),
      ),
    ).resolves.toBe(true);

    const message = push.mock.calls[0][1][0];
    expect(message.altText).toContain('Repair completed');
    expect(JSON.stringify(message)).toContain('/tickets/tkt_1/reopen');
    expect(JSON.stringify(message)).not.toContain('"hero"');
  });

  it.each([undefined, 'ASSIGNED', 'MERGED'])(
    'sends nothing for a status change to %s',
    async (toStatus) => {
      const { channel, push } = setup();
      await expect(
        channel.send(ticket(), 'Uaaa', event('STATUS_CHANGED', toStatus)),
      ).resolves.toBe(false);
      expect(push).not.toHaveBeenCalled();
    },
  );

  it('sends nothing for an event kind it has no message for', async () => {
    const { channel, push } = setup();
    await expect(
      channel.send(ticket(), 'Uaaa', event('PRIORITY_CHANGED')),
    ).resolves.toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('gives up on a message LINE rejects for good, without logging the user id', async () => {
    const { channel } = setup(
      vi.fn().mockRejectedValue(new LinePushError(400)),
    );

    await expect(
      channel.send(ticket(), 'Uaaa', event('TRIAGED')),
    ).resolves.toBe(false);

    expect(console.error).toHaveBeenCalledWith(
      'LINE rejected a message; not retrying',
      { ticketId: 'tkt_1', eventId: 'tkt_1_triaged', status: 400 },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'Uaaa',
    );
  });

  it.each([429, 500, 401])(
    'rethrows a retryable LINE failure (%i)',
    async (status) => {
      const { channel } = setup(
        vi.fn().mockRejectedValue(new LinePushError(status)),
      );
      await expect(
        channel.send(ticket(), 'Uaaa', event('TRIAGED')),
      ).rejects.toMatchObject({ name: 'LinePushError', status });
    },
  );

  it('rethrows any other failure', async () => {
    const { channel } = setup(vi.fn().mockRejectedValue(new Error('network')));
    await expect(
      channel.send(ticket(), 'Uaaa', event('TRIAGED')),
    ).rejects.toThrow('network');
  });
});

describe('flexOptionsFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the building security number and the LIFF URL', () => {
    vi.stubEnv('BUILDING_SECURITY_PHONE', '02-123-4567');
    vi.stubEnv('LIFF_URL', 'https://liff.line.me/abc');
    expect(flexOptionsFromEnv()).toEqual({
      securityPhone: '02-123-4567',
      liffUrl: 'https://liff.line.me/abc',
    });
  });

  it('treats empty values as not set', () => {
    vi.stubEnv('BUILDING_SECURITY_PHONE', '');
    vi.stubEnv('LIFF_URL', '');
    expect(flexOptionsFromEnv()).toEqual({
      securityPhone: undefined,
      liffUrl: undefined,
    });
  });
});
