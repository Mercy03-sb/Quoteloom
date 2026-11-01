import { Skeleton } from "./Skeleton";

/** Shared loading state for route segments (loading.tsx). */
export function PageSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading">
      <Skeleton height={36} width="40%" />
      <Skeleton height={160} />
      <div className="stats">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={96} />
        ))}
      </div>
      <div className="catalog-grid">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={220} />
        ))}
      </div>
    </div>
  );
}
