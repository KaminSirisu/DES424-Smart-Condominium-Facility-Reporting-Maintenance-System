import type { Ticket } from './types';

// Mock data until GET /tickets exists. IDs follow the backend format (tkt_ + hash).
const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

export const MOCK_TICKETS: Ticket[] = [
  {
    id: 'tkt_3f9a1c7e2b8d4a6f0e5c9b1d2a',
    description: 'Treadmill broken',
    location: 'Bldg B · Gym · Floor 8',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [
      { id: 'pho_treadmill', purpose: 'DEFECT', addedAt: hoursFromNow(-2) },
    ],
    priority: 'LOW',
    category: 'Gym machine',
    teamId: 'team-1',
    deadlineAt: hoursFromNow(7),
    createdAt: hoursFromNow(-2),
    updatedAt: hoursFromNow(-1),
  },
  {
    id: 'tkt_8c2e5b0a9d1f3e7c4b6a2d8f1e',
    description: 'Lift 2 makes a loud noise between floors 4-6',
    location: 'Bldg A · Passenger lift · Floor 5',
    status: 'IN_PROGRESS',
    repairCycle: 1,
    photos: [{ id: 'pho_lift', purpose: 'DEFECT', addedAt: hoursFromNow(-1) }],
    priority: 'MEDIUM',
    category: 'Passenger lift',
    teamId: 'team-1',
    acceptedByStaffId: 'staff-1',
    acceptedAt: hoursFromNow(-0.5),
    createdAt: hoursFromNow(-1),
    updatedAt: hoursFromNow(-0.5),
  },
  {
    id: 'tkt_1d7b3e9f5a2c8e0b6d4f1a3c9e',
    description: 'Corridor light flickering',
    location: 'Bldg A · Floor 3 corridor',
    status: 'DONE',
    repairCycle: 1,
    photos: [
      { id: 'pho_light', purpose: 'DEFECT', addedAt: hoursFromNow(-30) },
      {
        id: 'pho_light_fixed',
        purpose: 'REPAIR_PROOF',
        addedAt: hoursFromNow(-26),
        repairCycle: 1,
      },
    ],
    priority: 'LOW',
    teamId: 'team-1',
    acceptedByStaffId: 'staff-1',
    completedAt: hoursFromNow(-26),
    createdAt: hoursFromNow(-30),
    updatedAt: hoursFromNow(-26),
  },
  {
    id: 'tkt_5e0c2a8b4f6d1e3a9c7b5d2f8a',
    description: 'Pool pump leaking',
    location: 'Bldg C · Pool room',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [{ id: 'pho_pool', purpose: 'DEFECT', addedAt: hoursFromNow(-1) }],
    priority: 'CRITICAL',
    teamId: 'team-2',
    deadlineAt: hoursFromNow(2),
    createdAt: hoursFromNow(-1),
    updatedAt: hoursFromNow(-1),
  },
];
