import { describe, expect, it } from 'vitest';
import {
  triageQueueMonths,
  triageQueueWindow,
} from '../../backend/src/tickets/triage-queue';

describe('triageQueueMonths', () => {
  it('is three months by default and takes a whole number from 1 to 24', () => {
    expect(triageQueueMonths(undefined)).toBe(3);
    expect(triageQueueMonths('1')).toBe(1);
    expect(triageQueueMonths('12')).toBe(12);
    expect(triageQueueMonths('24')).toBe(24);
  });

  it.each(['', 'abc', '0', '-1', '25', '2.5', ' '])(
    'falls back to 3 for %j',
    (setting) => {
      expect(triageQueueMonths(setting)).toBe(3);
    },
  );
});

describe('triageQueueWindow', () => {
  const originalSetting = process.env.TRIAGE_QUEUE_MONTHS;

  it('lists the months oldest first, up to the one of now', () => {
    delete process.env.TRIAGE_QUEUE_MONTHS;
    expect(triageQueueWindow(new Date('2026-11-12T09:00:00.000Z'))).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
  });

  it('crosses the turn of the year', () => {
    delete process.env.TRIAGE_QUEUE_MONTHS;
    expect(triageQueueWindow(new Date('2027-01-05T09:00:00.000Z'))).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
  });

  it('follows TRIAGE_QUEUE_MONTHS', () => {
    process.env.TRIAGE_QUEUE_MONTHS = '1';
    expect(triageQueueWindow(new Date('2026-11-12T09:00:00.000Z'))).toEqual([
      '2026-11',
    ]);
    if (originalSetting === undefined) delete process.env.TRIAGE_QUEUE_MONTHS;
    else process.env.TRIAGE_QUEUE_MONTHS = originalSetting;
  });
});
