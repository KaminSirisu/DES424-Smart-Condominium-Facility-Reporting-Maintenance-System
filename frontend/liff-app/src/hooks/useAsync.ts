import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '../services/api';

type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

// Runs load() when the page opens and whenever `key` changes.
// Like useApi in the staff UI: an answer that arrives after the page moved on is ignored.
export function useAsync<T>(
  load: () => Promise<T>,
  key: unknown,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError(null);
    load()
      .then((value) => {
        if (!ignore) setData(value);
      })
      .catch((err: unknown) => {
        console.error(err);
        if (!ignore) setError(apiErrorMessage(err));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
    // load is a new function on every render, so it is left out on purpose:
    // key and attempt decide when to load again.
  }, [key, attempt]);

  return { data, error, loading, reload };
}
