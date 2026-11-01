"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui";

// AG Grid is browser-only and heavy: load it on the client only.
const loading = () => <Skeleton height={440} />;
export const LazyOrdersTable = dynamic(() => import("./OrdersTable").then((m) => m.OrdersTable), { ssr: false, loading });
export const LazyDisputesTable = dynamic(() => import("./DisputesTable").then((m) => m.DisputesTable), { ssr: false, loading });
