import type { StaffProfile } from './types';

const MOCK_STAFF: StaffProfile = {
  id: 'staff-1',
  name: 'Somchai',
  role: 'TECHNICIAN',
  teamId: 'team-1',
  teamName: 'Building Maintenance',
};
// GET /auth/staff/me
export function useCurrentStaff(): StaffProfile {
  return MOCK_STAFF;
}
