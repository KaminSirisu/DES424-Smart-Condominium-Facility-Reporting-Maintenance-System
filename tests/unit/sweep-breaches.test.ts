import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  listBreachedTickets: vi.fn(),
  markSlaBreached: vi.fn(),
}));

import { handler as entry } from '../../backend/src/handlers/sla-sweep-entry';
import { handler } from '../../backend/src/sla/sweep-breaches';
import {
  listBreachedTickets,
  markSlaBreached,
} from '../../backend/src/shared/ticket-repository';
import type { TicketRecord } from '../../backend/src/tickets/types';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const list = vi.mocked(listBreachedTickets);
const mark = vi.mocked(markSlaBreached);

const t = (id: string) => ({ id }) as TicketRecord;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('SLA sweep', () => {
  it('records the breach of every ticket found, with the same time', async () => {
    list.mockResolvedValue([t('a'), t('b')]);
    mark.mockResolvedValue(true);

    await expect(handler(NOW)).resolves.toEqual({ checked: 2, breached: 2 });

    expect(list).toHaveBeenCalledWith(NOW);
    expect(mark.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([
      ['a', NOW],
      ['b', NOW],
    ]);
  });

  it('counts only the breaches it recorded itself', async () => {
    list.mockResolvedValue([t('a'), t('b'), t('c')]);
    mark.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mark.mockResolvedValueOnce(true);
    await expect(handler(NOW)).resolves.toEqual({ checked: 3, breached: 2 });
  });

  it('does nothing when nothing is overdue', async () => {
    list.mockResolvedValue([]);
    await expect(handler(NOW)).resolves.toEqual({ checked: 0, breached: 0 });
    expect(mark).not.toHaveBeenCalled();
  });

  it('records the others when one fails, then reports the first failure', async () => {
    list.mockResolvedValue([t('a'), t('b'), t('c')]);
    mark
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('second'));

    await expect(handler(NOW)).rejects.toThrow('first');

    expect(mark).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it('fails when the tickets cannot be listed', async () => {
    list.mockRejectedValue(new Error('index unavailable'));
    await expect(handler(NOW)).rejects.toThrow('index unavailable');
  });

  it('is what the EventBridge entry point runs, with the current time', async () => {
    list.mockResolvedValue([]);
    await expect(entry()).resolves.toEqual({ checked: 0, breached: 0 });
    expect(list.mock.calls[0][0]).toBeInstanceOf(Date);
  });
});
