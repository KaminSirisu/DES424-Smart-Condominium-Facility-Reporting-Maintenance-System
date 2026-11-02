export function formatTimeLeft(deadlineAt: string, now = Date.now()): string {
  const msLeft = new Date(deadlineAt).getTime() - now;
  if (msLeft <= 0) return 'Overdue';

  const totalMinutes = Math.floor(msLeft / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
