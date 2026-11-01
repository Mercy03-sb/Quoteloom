"use client";

import type { ColDef } from "ag-grid-community";
import { useMemo } from "react";
import { formatCents } from "@/lib/catalog";
import { DISPUTE_LABELS } from "@/lib/dispute-labels";
import type { DisputeListItem } from "@/lib/disputes";
import { FilteredGrid } from "./FilteredGrid";

const searchOf = (r: DisputeListItem) => `${r.id} ${r.paypal_dispute_id ?? ""} ${r.title} ${r.reason} ${r.order_id}`;
const hrefOf = (r: DisputeListItem) => `/disputes/${r.id}`;

export function DisputesTable({ rows }: { rows: DisputeListItem[] }) {
  const cols = useMemo<ColDef<DisputeListItem>[]>(
    () => [
      { field: "created_at", headerName: "Opened", minWidth: 170, valueFormatter: (p) => (p.value ? `${String(p.value).slice(0, 16)} UTC` : ""), sort: "desc" },
      { field: "title", headerName: "Product", flex: 2, minWidth: 200 },
      { field: "reason", headerName: "Reason", flex: 2, minWidth: 240, valueFormatter: (p) => DISPUTE_LABELS[p.value as string] ?? p.value ?? "" },
      { field: "amount_cents", headerName: "Amount", type: "rightAligned", minWidth: 120, valueFormatter: (p) => `${formatCents(p.value ?? 0)} ${p.data?.currency ?? ""}` },
      { field: "status", headerName: "Evidence", width: 130 },
      { headerName: "Kind", width: 120, valueGetter: (p) => (p.data?.simulated ? "Simulated" : "PayPal") },
      { field: "paypal_dispute_id", headerName: "Dispute id", minWidth: 170, cellStyle: { fontFamily: "var(--f-mono)", fontSize: 12 } },
    ],
    [],
  );
  return (
    <FilteredGrid
      rows={rows}
      columnDefs={cols}
      statuses={["OPEN", "SUBMITTED", "RESOLVED"]}
      hrefOf={hrefOf}
      searchOf={searchOf}
      label="disputes"
      emptyTitle="No disputes"
      emptyText="Disputes arrive from PayPal webhooks. For a demo, open a paid order and use Simulate dispute."
    />
  );
}
