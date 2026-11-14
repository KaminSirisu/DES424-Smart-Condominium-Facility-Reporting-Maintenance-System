// One grey pulsing block. Size it with Tailwind classes (h-4 w-32 …).
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded-md bg-slate-200 motion-safe:animate-pulse ${className}`}
    />
  );
}

export function TicketSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-6 w-24 rounded-full" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
