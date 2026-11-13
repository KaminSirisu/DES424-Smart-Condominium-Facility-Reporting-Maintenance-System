import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../services/api';

export function useApi<T>(load: () => Promise<T>, key: string | number = '') {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}