import type { ReactNode } from 'react';
import { PageSkeleton } from './Skeleton';

type Props = {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** What to show while loading. Defaults to a page with 4 cards and a table. */
  skeleton?: ReactNode;
};

/** Skeleton while loading, an error with Retry, or nothing when the data is ready. */
export default function LoadState({
  loading,
  error,
  onRetry,
  skeleton,
}: Props) {
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}{' '}
        <button onClick={onRetry} className="font-medium underline">
          Retry
        </button>
      </div>
    );
  }
  if (loading) return <>{skeleton ?? <PageSkeleton />}</>;
  return null;
}
