/** Human-readable ticket reference; the full ID remains the API and URL key. */
export function ticketReference(ticketId: string): string {
  return '#' + ticketId.replace(/^tkt_/, '').slice(0, 8).toUpperCase();
}
