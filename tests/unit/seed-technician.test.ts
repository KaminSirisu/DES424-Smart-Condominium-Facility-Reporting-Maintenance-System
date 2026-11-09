import { describe, expect, it } from 'vitest';
import { parseTechnicianArgs } from '../../backend/src/scripts/seed-technician.js';

describe('single technician account seed', () => {
  it('normalizes the login name and accepts a configured team', () => {
    expect(
      parseTechnicianArgs([
        '--email',
        ' Plumber@Example.com ',
        '--team',
        'PLUMBING',
      ]),
    ).toEqual({ email: 'plumber@example.com', teamId: 'PLUMBING' });
  });

  it('rejects a misspelled team before creating an account', () => {
    expect(() =>
      parseTechnicianArgs([
        '--email',
        'plumber@example.com',
        '--team',
        'PLUMBER',
      ]),
    ).toThrow('--team must be one of the five configured team IDs.');
  });
});
