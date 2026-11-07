import { useState } from 'react';
import { TicketActionError } from '../services/tickets';

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof TicketActionError
          ? e.message
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}
