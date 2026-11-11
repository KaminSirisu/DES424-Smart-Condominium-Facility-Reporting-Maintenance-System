import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  listOpenTickets: vi.fn(),
  recordSlaAlert: vi.fn(),
}));
vi.mock('../../backend/src/sla/alerts', () => ({ dueAlerts: vi.fn() }));

import { handler as entry } from '../../backend/src/handlers/sla-sweep-entry';
import { dueAlerts } from '../../backend/src/sla/alerts';
import { handler } from '../../backend/src/sla/sweep-breaches';
import {
  listOpenTickets,
  recordSlaAlert,
} from '../../backend/src/shared/ticket-repository';
import type { TicketRecord } from '../../backend/src/tickets/types';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const list = vi.mocked(listOpenTickets);
const record = vi.mocked(recordSlaAlert);
const due = vi.mocked(dueAlerts);

const t = (id: string) => ({ id }) as TicketRecord;
const warning = { kind: 'WARNING' } as const;
const response = { kind: 'RESPONSE_BREACH' } as const;
const breach = { kind: 'RESOLUTION_BREACH', sent: 0 } as const;

beforeEach(() => {
  vi.resetAllMocks();
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
