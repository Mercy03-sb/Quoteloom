"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { quoteloomGridTheme } from "@/components/catalog/CatalogGrid";
import { EmptyState } from "@/components/ui";

export type GridRow = { id: string; status: string };

/**
 * AG Grid table with a toolbar (status chips + text search) on top of AG Grid's own column filters.
 * Clicking a row opens `hrefOf(row)`. `extra` adds one more yes/no filter.
 */
export function FilteredGrid<T extends GridRow>({
  rows,
  columnDefs,
  statuses,
  hrefOf,
  searchOf,
  emptyTitle,
  emptyText,
  label,
  extra,
}: {
  rows: T[];
  columnDefs: ColDef<T>[];
  statuses: string[];
  hrefOf: (row: T) => string;
  searchOf: (row: T) => string;
  emptyTitle: string;
  emptyText: string;
  label: string;
  extra?: { label: string; test: (row: T) => boolean };
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string>("ALL");
  const [text, setText] = useState("");
  const [only, setOnly] = useState(false);

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    return rows.filter(
      (r) => (status === "ALL" || r.status === status) && (!only || !extra || extra.test(r)) && (!q || searchOf(r).toLowerCase().includes(q)),
    );
  }, [rows, status, text, only, extra, searchOf]);

  if (rows.length === 0) return <EmptyState title={emptyTitle}>{emptyText}</EmptyState>;

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label={`${label} status`}>
          {["ALL", ...statuses].map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <input
          className="toolbar-search"
          type="search"
          placeholder="Search…"
          aria-label={`Search ${label}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {extra && (
          <label className="toolbar-check">
            <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> {extra.label}
          </label>
        )}
        <span className="stat-note toolbar-count">
          {shown.length} of {rows.length}
        </span>
      </div>
      <div className="grid-box grid-box-records">
        <AgGridReact<T>
          theme={quoteloomGridTheme}
          rowData={shown}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true, suppressHeaderMenuButton: true }}
          getRowId={(p) => p.data.id}
          onRowClicked={(e) => e.data && router.push(hrefOf(e.data))}
          rowClass="row-link"
          pagination={shown.length > 25}
          overlayNoRowsTemplate="Nothing matches these filters."
        />
      </div>
    </div>
  );
}
