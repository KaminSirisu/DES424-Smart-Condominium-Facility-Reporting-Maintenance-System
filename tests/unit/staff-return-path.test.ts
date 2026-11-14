import { describe, expect, it } from 'vitest';
import { postLoginPath } from '../../frontend/admin-dashboard/src/services/session';

const ticketId = 'tkt_a429813a25fcbd41e17e1fac07';

describe('postLoginPath', () => {
  it('returns a manager to the ticket linked from an SLA email', () => {
    expect(postLoginPath('MANAGER', `/tickets/${ticketId}`)).toBe(
      `/tickets/${ticketId}`,
    );
  });

  it('returns a technician to the job linked from a team email', () => {
    expect(postLoginPath('TECHNICIAN', `/tech/jobs/${ticketId}`)).toBe(
      `/tech/jobs/${ticketId}`,
    );
  });

  it('does not send a user to another role or an external destination', () => {
    expect(postLoginPath('TECHNICIAN', `/tickets/${ticketId}`)).toBe('/tech');
    expect(postLoginPath('MANAGER', `/tech/jobs/${ticketId}`)).toBe('/');
    expect(postLoginPath('MANAGER', '//outside.example/tickets/x')).toBe('/');
    expect(postLoginPath('MANAGER', 'https://outside.example')).toBe('/');
  });
});
