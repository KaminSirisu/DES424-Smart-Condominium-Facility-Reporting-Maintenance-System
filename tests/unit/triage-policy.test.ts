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
    expect(resolutionHours('PLUMBING', 'CRITICAL')).toBe(4);
    expect(resolutionHours('PLUMBING', 'MEDIUM')).toBe(24);
    expect(resolutionHours('PLUMBING', 'LOW')).toBe(120);
  });

  it('counts the deadline from ticket creation', () => {
    expect(
      computeDeadline('2026-10-28T10:00:00.000Z', 'ELECTRICAL', 'CRITICAL'),
    ).toBe('2026-10-28T14:00:00.000Z');
    expect(computeDeadline('2026-10-28T10:00:00.000Z', 'HVAC', 'LOW')).toBe(
      '2026-11-02T10:00:00.000Z',
    );
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
