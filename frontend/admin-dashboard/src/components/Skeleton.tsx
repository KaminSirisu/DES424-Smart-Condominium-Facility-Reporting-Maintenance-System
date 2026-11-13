type BlockProps = { className?: string };

/** One grey pulsing block. Size it with Tailwind classes (h-4 w-32 …). */
export function Skeleton({ className = '' }: BlockProps) {
  return (
    <div
      className={`rounded-md bg-slate-200 motion-safe:animate-pulse ${className}`}
    />
  );
}

/** Table-shaped skeleton: header line + rows like TicketTable. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col">
      <Skeleton className="mb-4 h-4 w-full max-w-lg" />
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-slate-100 py-4"
        >
          <Skeleton className="h-4 w-20" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Whole-page skeleton: title, stat cards, one table card. */
export function PageSkeleton({
  cards = 4,
  rows = 6,
}: {
  cards?: number;
  rows?: number;
}) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-6">
      <Skeleton className="h-8 w-64" />
      {cards > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: cards }, (_, i) => (
            <div key={i} className="rounded-2xl border border-slate-200 p-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-4 h-8 w-12" />
            </div>
          ))}
        </div>
      )}
      <div className="rounded-2xl border border-slate-200 p-5">
        <TableSkeleton rows={rows} />
      </div>
    </div>
  );
}

/** Stack of cards, for the Needs triage page. */
export function CardListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-4">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-5"
        >
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="h-9 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Inside the ticket drawer, while the ticket loads. */
export function DrawerSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-8 w-full rounded-xl" />
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-20" />
      </div>
    </div>
  );
}

/** Activity timeline lines in the drawer. */
export function TimelineSkeleton({ items = 3 }: { items?: number }) {
  return (
    <div className="flex flex-col gap-4 border-l border-slate-200 pl-4">
      {Array.from({ length: items }, (_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
