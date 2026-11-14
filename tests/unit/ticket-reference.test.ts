import { describe, expect, it } from 'vitest';
import { ticketReference } from '../../backend/src/notifications/ticket-reference';

describe('ticketReference', () => {
  it('matches the staff dashboard display for a real ticket ID', () => {
    expect(ticketReference('tkt_a429813a25fcbd41e17e1fac07')).toBe('#A429813A');
  });
});
