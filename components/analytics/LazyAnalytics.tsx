"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui";

// AG Grid is browser-only and heavy: load it on the client only, with a skeleton while it loads.
const loading = () => <Skeleton height={240} />;
export const LazySalesGrid = dynamic(() => import("./AnalyticsGrids").then((m) => m.SalesGrid), { ssr: false, loading });
export const LazyAgentGrid = dynamic(() => import("./AnalyticsGrids").then((m) => m.AgentGrid), { ssr: false, loading });
export const LazyUnmetGrid = dynamic(() => import("./AnalyticsGrids").then((m) => m.UnmetGrid), { ssr: false, loading });
export const LazyDisputeGrid = dynamic(() => import("./AnalyticsGrids").then((m) => m.DisputeGrid), { ssr: false, loading });
