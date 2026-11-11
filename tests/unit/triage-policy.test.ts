import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  TEAM_FOR_CATEGORY,
  TEAM_IDS,
  computeDeadline,
  isCategory,
  isLevel,
  isPriority,
  isTeamId,
  priorityFor,
  resolutionHours,
  responseMinutes,
  SLA_POLICY_VERSION,
  SLA_REPEAT_MINUTES,
  SLA_WARNING_SHARE,
  slaStartOf,
} from '../../backend/src/triage/policy';

describe('triage policy', () => {
  it.each([
    ['HIGH', 'HIGH', 'CRITICAL'],
    ['HIGH', 'MEDIUM', 'CRITICAL'],
    ['HIGH', 'LOW', 'MEDIUM'],
    ['MEDIUM', 'HIGH', 'CRITICAL'],
    ['MEDIUM', 'MEDIUM', 'MEDIUM'],
    ['MEDIUM', 'LOW', 'LOW'],
    ['LOW', 'HIGH', 'MEDIUM'],
    ['LOW', 'MEDIUM', 'LOW'],
    ['LOW', 'LOW', 'LOW'],
  ] as const)('impact %s × urgency %s is %s', (impact, urgency, expected) => {
    expect(priorityFor(impact, urgency)).toBe(expected);
  });

  it('gives each priority its default resolution time', () => {
    expect(resolutionHours('PLUMBING', 'CRITICAL')).toBe(3);
    expect(resolutionHours('PLUMBING', 'MEDIUM')).toBe(12);
    expect(resolutionHours('PLUMBING', 'LOW')).toBe(48);
  });

  it('gives each priority its response target and the SLA constants', () => {
    expect(responseMinutes('CRITICAL')).toBe(15);
    expect(responseMinutes('MEDIUM')).toBe(120);
    expect(responseMinutes('LOW')).toBe(1440);
    expect(SLA_WARNING_SHARE).toBe(0.75);
    expect(SLA_REPEAT_MINUTES).toBe(60);
    expect(SLA_POLICY_VERSION).toBe(2);
  });

  it('counts the deadline from ticket creation', () => {
    expect(
      computeDeadline('2026-10-28T10:00:00.000Z', 'ELECTRICAL', 'CRITICAL'),
    ).toBe('2026-10-28T13:00:00.000Z');
    expect(computeDeadline('2026-10-28T10:00:00.000Z', 'HVAC', 'LOW')).toBe(
      '2026-10-30T10:00:00.000Z',
    );
    expect(computeDeadline('2026-10-28T10:00:00.000Z', 'HVAC', 'MEDIUM')).toBe(
      '2026-10-28T22:00:00.000Z',
    );
  });

  it('starts the SLA clock at creation, or at the earlier start a merge took over', () => {
    expect(slaStartOf({ createdAt: '2026-10-28T10:00:00.000Z' })).toBe(
      '2026-10-28T10:00:00.000Z',
    );
    expect(
      slaStartOf({
        createdAt: '2026-10-28T10:00:00.000Z',
        slaStartAt: '2026-10-28T08:00:00.000Z',
      }),
    ).toBe('2026-10-28T08:00:00.000Z');
  });

  it('maps every category to a known team', () => {
    for (const category of CATEGORIES) {
      expect(TEAM_IDS).toContain(TEAM_FOR_CATEGORY[category]);
    }
  });

  it('accepts only known enum values', () => {
    expect(isTeamId('PLUMBING')).toBe(true);
    expect(isTeamId('plumbing')).toBe(false);
    expect(isTeamId('ASSIGN_ME_TO_MANAGER')).toBe(false);
    expect(isCategory('HVAC')).toBe(true);
    expect(isCategory(undefined)).toBe(false);
    expect(isPriority('CRITICAL')).toBe(true);
    expect(isPriority('HIGH')).toBe(false);
    expect(isLevel('HIGH')).toBe(true);
    expect(isLevel('CRITICAL')).toBe(false);
  });
});
