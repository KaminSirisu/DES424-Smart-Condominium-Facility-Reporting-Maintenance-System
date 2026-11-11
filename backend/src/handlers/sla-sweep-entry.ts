import { handler as sweep } from '../sla/sweep-breaches.js';

/** Entry point of the EventBridge rule that runs the SLA sweep. */
export async function handler(): Promise<{
  checked: number;
  breached: number;
}> {
  return sweep();
}
