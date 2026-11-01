"use client";

import type { ColDef } from "ag-grid-community";
import { useMemo } from "react";
import { formatCents } from "@/lib/catalog";
import type { OrderListItem } from "@/lib/orders-view";
import { FilteredGrid } from "./FilteredGrid";

const money = (c: number | null | undefined, cur?: string) => (c == null ? "" : `${formatCents(c)} ${cur ?? ""}`.trim());
const when = (s: string | null) => (s ? `${s.slice(0, 16).replace("T", " ")} UTC` : "");

const searchOf = (r: OrderListItem) => `${r.id} ${r.title} ${r.sku} ${r.shop_slug}`;
const hrefOf = (r: OrderListItem) => `/orders/${r.id}`;
const NEGOTIATED = { label: "Negotiated only", test: (r: OrderListItem) => r.negotiated };

export function OrdersTable({ rows }: { rows: OrderListItem[] }) {
  const cols = useMemo<ColDef<OrderListItem>[]>(
    () => [
      { field: "created_at", headerName: "Created", minWidth: 170, valueFormatter: (p) => when(p.value), sort: "desc" },
      { field: "title", headerName: "Product", flex: 2, minWidth: 200 },
      { field: "qty", headerName: "Qty", type: "rightAligned", width: 90 },
      {
        headerName: "Unit price",
        type: "rightAligned",
        minWidth: 130,
        valueGetter: (p) => p.data?.unit_price_cents,
        valueFormatter: (p) => money(p.value, p.data?.currency),
      },
      { headerName: "Negotiated", width: 140, valueGetter: (p) => (p.data?.negotiated ? "Yes" : "No") },
      { field: "amount_cents", headerName: "Total", type: "rightAligned", minWidth: 120, valueFormatter: (p) => money(p.value, p.data?.currency) },
      { field: "status", headerName: "Status", width: 130 },
      { field: "disputes", headerName: "Disputes", type: "rightAligned", width: 120 },
      { field: "id", headerName: "Order", minWidth: 190, cellStyle: { fontFamily: "var(--f-mono)", fontSize: 12 } },
    ],
    [],
  );
  return (
    <FilteredGrid
      rows={rows}
      columnDefs={cols}
      statuses={["CREATED", "APPROVED", "PAID", "FAILED", "REFUNDED"]}
      hrefOf={hrefOf}
      searchOf={searchOf}
      label="orders"
      emptyTitle="No orders yet"
      emptyText="Orders appear here after a buyer agent checks out. Try the Buyer chat: search, get a quote (try an offer) and pay in simulation mode."
      extra={NEGOTIATED}
    />
  );
}
