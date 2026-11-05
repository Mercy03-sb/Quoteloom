"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Skeleton } from "@/components/ui";
import { StudioBoundary } from "./StudioBoundary";

// AG Studio is browser-only and large: client-side import only, never on the server render.
const LazyStudio = dynamic(() => import("./StudioView"), { ssr: false, loading: () => <Skeleton height={560} /> });

export type Unavailable = "missing" | "invalid" | "expired" | "failed" | "small";

export const NOTICES: Record<Unavailable, string> = {
  missing: "AG Studio is off because no licence key is configured. This is the AG Grid Community version of the same analytics.",
  invalid: "AG Studio is off because its licence key was not accepted. This is the AG Grid Community version of the same analytics.",
  expired: "AG Studio is off because its trial licence has expired. This is the AG Grid Community version of the same analytics.",
  failed: "AG Studio could not load, so this is the AG Grid Community version of the same analytics. Reload to try again.",
  small: "AG Studio is best on a larger screen (a tablet or desktop). Here is the AG Grid Community version of the same analytics; open this page on a wider screen for the editable dashboard.",
};

/** Chooses between AG Studio and the Community analytics (passed in as `fallback`). */
export function StudioGate({ shop, fallback }: { shop: string; fallback: ReactNode }) {
  const key = process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY?.trim() || undefined;
  const [reason, setReason] = useState<Unavailable | null>(key ? null : "missing");
  const [small, setSmall] = useState<boolean | null>(null);
  const onUnavailable = useCallback((r: "invalid" | "expired" | "failed") => setReason(r), []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setSmall(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const shown: Unavailable | null = reason ?? (small ? "small" : null);
  if (shown) {
    return (
      <div className="stack" data-testid="studio-fallback" data-reason={shown}>
        <div className="notice" data-tone="warning" role="status">{NOTICES[shown]}</div>
        {fallback}
      </div>
    );
  }
  if (small === null || !key) return <Skeleton height={560} />;
  return (
    <StudioBoundary onError={() => setReason("failed")}>
      <LazyStudio shop={shop} licenceKey={key} onUnavailable={onUnavailable} />
    </StudioBoundary>
  );
}
