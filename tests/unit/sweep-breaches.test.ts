import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  listAllReceivedTickets: vi.fn(),
  listOpenTickets: vi.fn(),
  recordSlaAlert: vi.fn(),
}));
vi.mock('../../backend/src/sla/alerts', () => ({ dueAlerts: vi.fn() }));

import { handler as entry } from '../../backend/src/handlers/sla-sweep-entry';
import { dueAlerts } from '../../backend/src/sla/alerts';
import { handler } from '../../backend/src/sla/sweep-breaches';
import {
  listAllReceivedTickets,
  listOpenTickets,
  recordSlaAlert,
} from '../../backend/src/shared/ticket-repository';
import type { TicketRecord } from '../../backend/src/tickets/types';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const list = vi.mocked(listOpenTickets);
const listWaiting = vi.mocked(listAllReceivedTickets);
const record = vi.mocked(recordSlaAlert);
const due = vi.mocked(dueAlerts);

const t = (id: string) => ({ id }) as TicketRecord;
const warning = { kind: 'WARNING' } as const;
const response = { kind: 'RESPONSE_BREACH' } as const;
const breach = { kind: 'RESOLUTION_BREACH', sent: 0 } as const;

beforeEach(() => {
  vi.resetAllMocks();
  listWaiting.mockResolvedValue([]);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('SLA sweep', () => {
  it('records every alert each open ticket owes, in order, with the same time', async () => {
    list.mockResolvedValue([t('a'), t('b')]);
    due.mockImplementation((ticket) =>
      ticket.id === 'a' ? [response, breach] : [warning],
    );
    record.mockResolvedValue(true);

    await expect(handler(NOW)).resolves.toEqual({ checked: 2, recorded: 3 });

    expect(due.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([
      ['a', NOW],
      ['b', NOW],
    ]);
    expect(record.mock.calls.map((c) => [c[0].id, c[1], c[2]])).toEqual([
      ['a', response, NOW],
      ['a', breach, NOW],
      ['b', warning, NOW],
    ]);
  });

  it('also looks at the tickets waiting for triage, first, over the last three months', async () => {
    list.mockResolvedValue([t('open')]);
    listWaiting.mockResolvedValue([t('waiting')]);
    due.mockImplementation((ticket) =>
      ticket.id === 'waiting' ? [{ kind: 'TRIAGE_DELAYED' }] : [],
    );
    record.mockResolvedValue(true);

    await expect(handler(NOW)).resolves.toEqual({ checked: 2, recorded: 1 });

    expect(listWaiting).toHaveBeenCalledWith(['2026-09', '2026-10', '2026-11']);
    expect(due.mock.calls.map((c) => c[0].id)).toEqual(['waiting', 'open']);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'waiting' }),
      { kind: 'TRIAGE_DELAYED' },
      NOW,
    );
  });

  it('still records the alerts of the open tickets when the waiting tickets cannot be read, then reports it', async () => {
    list.mockResolvedValue([t('open')]);
    listWaiting.mockRejectedValue(new Error('index not allowed'));
    due.mockReturnValue([warning]);
    record.mockResolvedValue(true);

    await expect(handler(NOW)).rejects.toThrow('index not allowed');

    expect(record).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      'Reading the tickets waiting for triage failed',
      expect.anything(),
    );
  });

  it('counts only the alerts it recorded itself', async () => {
    list.mockResolvedValue([t('a'), t('b'), t('c')]);
    due.mockReturnValue([warning]);
    record
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(handler(NOW)).resolves.toEqual({ checked: 3, recorded: 2 });
  });

  it('does nothing when no ticket owes an alert', async () => {
    list.mockResolvedValue([t('a')]);
    due.mockReturnValue([]);
    await expect(handler(NOW)).resolves.toEqual({ checked: 1, recorded: 0 });
    expect(record).not.toHaveBeenCalled();

    list.mockResolvedValue([]);
    await expect(handler(NOW)).resolves.toEqual({ checked: 0, recorded: 0 });
  });

  it('records the others when one fails, then reports the first failure', async () => {
    list.mockResolvedValue([t('a'), t('b'), t('c')]);
    due.mockReturnValue([warning]);
    record
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('second'));

    await expect(handler(NOW)).rejects.toThrow('first');

    expect(record).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it('fails when the tickets cannot be listed', async () => {
    list.mockRejectedValue(new Error('index unavailable'));
    await expect(handler(NOW)).rejects.toThrow('index unavailable');
  });

  it('is what the EventBridge entry point runs, with the current time', async () => {
    list.mockResolvedValue([t('a')]);
    due.mockReturnValue([]);
    await expect(entry()).resolves.toEqual({ checked: 1, recorded: 0 });
    expect(due.mock.calls[0][1]).toBeInstanceOf(Date);
  });
});
