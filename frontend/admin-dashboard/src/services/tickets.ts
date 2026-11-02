import { MOCK_TICKETS } from './mockTickets';
import type { Ticket } from './types';

// TODO: replace with GET /tickets (useState + useEffect) when the API exists.
export function useTeamTickets(teamId: string | undefined): Ticket[] {
  return MOCK_TICKETS.filter((ticket) => ticket.teamId === teamId);
}
