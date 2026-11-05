"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useState } from "react";
import { quoteloomGridTheme } from "@/components/catalog/CatalogGrid";
import { formatCents } from "@/lib/catalog";
import { DISPUTE_LABELS } from "@/lib/dispute-labels";
import type { AgentRow, DayPoint, DisputeRow, UnmetWithSuggestions } from "@/lib/analytics";

const defaultColDef: ColDef = { sortable: true, resizable: true, suppressHeaderMenuButton: true };

function Grid<T>({ rows, cols, label, getId }: { rows: T[]; cols: ColDef<T>[]; label: string; getId: (r: T) => string }) {
  return (
    <div className="grid-box-auto" role="region" aria-label={label}>
      <AgGridReact<T>
        theme={quoteloomGridTheme}
        rowData={rows}
        columnDefs={cols}
        defaultColDef={defaultColDef}
        getRowId={(p) => getId(p.data)}
        domLayout="autoHeight"
        pagination={rows.length > 10}
        paginationPageSize={10}
        paginationPageSizeSelector={false}
      />
    </div>
  );
}

const demoCol = <T extends { demo: number }>(): ColDef<T> => ({
  headerName: "Data",
  width: 110,
  sortable: false,
  valueGetter: (p) => (p.data?.demo ? "Demo" : "Live"),
});

const moneyFmt = (v: unknown) => formatCents(Number(v ?? 0));

export function SalesGrid({ rows }: { rows: DayPoint[] }) {
  const cols: ColDef<DayPoint>[] = [
    { field: "day", headerName: "Day", sort: "desc", minWidth: 120 },
    { field: "orders", headerName: "Orders", type: "rightAligned", width: 100 },
    { field: "paid", headerName: "Paid", type: "rightAligned", width: 90 },
    { field: "revenue_cents", headerName: "Revenue (USD)", type: "rightAligned", minWidth: 140, valueFormatter: (p) => moneyFmt(p.value) },
    demoCol<DayPoint>(),
  ];
  return <Grid rows={rows} cols={cols} label="Orders by day" getId={(r) => r.day} />;
}

export function AgentGrid({ rows }: { rows: AgentRow[] }) {
  const cols: ColDef<AgentRow>[] = [
    { field: "agent", headerName: "Agent id", flex: 2, minWidth: 180 },
    { field: "searches", headerName: "Searches", type: "rightAligned", sort: "desc", width: 120 },
    { field: "zero_results", headerName: "No results", type: "rightAligned", width: 120 },
    { field: "last_seen", headerName: "Last seen (UTC)", minWidth: 160, valueFormatter: (p) => String(p.value ?? "").slice(0, 16) },
    demoCol<AgentRow>(),
  ];
  return <Grid rows={rows} cols={cols} label="Searches per agent" getId={(r) => r.agent} />;
}

export function DisputeGrid({ rows }: { rows: DisputeRow[] }) {
  const cols: ColDef<DisputeRow>[] = [
    { field: "created_at", headerName: "Opened (UTC)", sort: "desc", minWidth: 160, valueFormatter: (p) => String(p.value ?? "").slice(0, 16) },
    { field: "reason", headerName: "Reason", flex: 2, minWidth: 220, valueFormatter: (p) => DISPUTE_LABELS[p.value as string] ?? String(p.value ?? "") },
    { field: "amount_cents", headerName: "Amount", type: "rightAligned", minWidth: 120, valueFormatter: (p) => `${moneyFmt(p.value)} ${p.data?.currency ?? ""}` },
    { field: "status", headerName: "Status", width: 130 },
    demoCol<DisputeRow>(),
  ];
  return <Grid rows={rows} cols={cols} label="Disputes" getId={(r) => r.id} />;
}

/** Product thumbnail with a plain-img fallback: any retailer image host is allowed, and a broken one just disappears. */
export function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <span className="thumb thumb-empty" aria-hidden="true" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="thumb" src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" width={36} height={36} onError={() => setBad(true)} />;
}

function Suggestions({ data }: ICellRendererParams<UnmetWithSuggestions>) {
  const s = data?.suggestions ?? [];
  if (!s.length) return <span className="stat-note">No suggestions available</span>;
  return (
    <ul className="suggest-list">
      {s.map((p, i) => (
        <li key={i}>
          <Thumb src={p.image} alt="" />
          <span>
            {p.title}
            <br />
            <span className="stat-note">
              {p.price.toFixed(2)} {p.currency} at {p.retailer}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function UnmetGrid({ rows }: { rows: UnmetWithSuggestions[] }) {
  const cols: ColDef<UnmetWithSuggestions>[] = [
    { field: "query", headerName: "Searched for", flex: 1, minWidth: 160 },
    { field: "searches", headerName: "Times", type: "rightAligned", sort: "desc", width: 90 },
    { field: "agents", headerName: "Agents", type: "rightAligned", width: 100 },
    { headerName: "No results / weak", width: 150, sortable: false, valueGetter: (p) => `${p.data?.zero ?? 0} / ${p.data?.weak ?? 0}` },
    { headerName: "Consider stocking (similar items, via Channel3)", flex: 3, minWidth: 320, sortable: false, autoHeight: true, cellRenderer: Suggestions },
    { headerName: "Source", width: 110, valueGetter: (p) => p.data?.source ?? "none" },
    demoCol<UnmetWithSuggestions>(),
  ];
  return <Grid rows={rows} cols={cols} label="Unmet demand" getId={(r) => r.id} />;
}
