/** The staff portal serves both roles at one origin, with different ticket routes. */
export function staffTicketLink(
  portalUrl: string,
  ticketId: string,
  role: 'MANAGER' | 'TECHNICIAN',
): string {
  const route = role === 'MANAGER' ? 'tickets' : 'tech/jobs';
  return `${portalUrl.replace(/\/+$/, '')}/${route}/${encodeURIComponent(ticketId)}`;
}
