"use client";

import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type { CellClassParams, ColDef, ValueSetterParams } from "ag-grid-community";
import { useMemo } from "react";
import { quoteloomGridTheme } from "@/components/catalog/CatalogGrid";
import { formatCents } from "@/lib/catalog";
import { findProblems, parsePriceToCents, type DraftProduct, type ProblemField } from "@/lib/ingest/draft";

export type DraftRow = DraftProduct & { _id: string };
type Ctx = { onDelete: (id: string) => void };

export const ROW_HEIGHT = 46;
export const HEADER_HEIGHT = 44;
export const SCROLLBAR_ALLOWANCE = 18; // a horizontal scrollbar on narrow screens must not steal row space
export const GRID_MIN_HEIGHT = 200; // room for the "no rows" message
export const GRID_MAX_HEIGHT = 520; // taller drafts scroll inside the grid

/** Grid height that fits its rows: header + rows (+ border), clamped to a sensible minimum and maximum. */
export function gridHeight(rowCount: number): number {
  return Math.min(GRID_MAX_HEIGHT, Math.max(GRID_MIN_HEIGHT, HEADER_HEIGHT + rowCount * ROW_HEIGHT + 2 + SCROLLBAR_ALLOWANCE));
}

function DeleteCell(props: CustomCellRendererProps<DraftRow, unknown, Ctx>) {
  const row = props.data;
  if (!row) return null;
  return (
    <button
      type="button"
      className="grid-del"
      title="Delete row"
      aria-label={`Delete ${row.title || "this row"}`}
      onClick={() => props.context.onDelete(row._id)}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </svg>
    </button>
  );
}

/**
 * Editable draft catalog. Edits flow back through onChange; invalid cells are outlined and block Publish.
 * Columns share the available width (flex) and only scroll sideways when the screen is too narrow for their minimums.
 */
export function ReviewGrid({ rows, onChange, onDelete }: { rows: DraftRow[]; onChange: (row: DraftRow) => void; onDelete: (id: string) => void }) {
  const problems = useMemo(() => findProblems(rows), [rows]);
  const bad = (field: ProblemField) => (p: CellClassParams<DraftRow>) => Boolean(p.data && problems[p.data._id]?.includes(field));

  const columnDefs = useMemo<ColDef<DraftRow>[]>(
    () => [
      { field: "sku", headerName: "SKU", editable: true, flex: 1.6, minWidth: 150, tooltipField: "sku", cellClassRules: { "cell-bad": bad("sku") }, cellStyle: { fontFamily: "var(--f-mono)", fontSize: 13 } },
      { field: "title", headerName: "Product", editable: true, flex: 2, minWidth: 150, cellClassRules: { "cell-bad": bad("title") } },
      { field: "description", headerName: "Description", editable: true, flex: 2.2, minWidth: 130 },
      {
        colId: "price",
        headerName: "Price",
        editable: true,
        type: "rightAligned",
        flex: 0.9,
        minWidth: 84,
        valueGetter: (p) => (p.data && p.data.price_cents > 0 ? formatCents(p.data.price_cents) : ""),
        valueSetter: (p: ValueSetterParams<DraftRow>) => {
          const cents = parsePriceToCents(p.newValue);
          p.data.price_cents = cents ?? 0; // 0 is flagged, so a typo cannot slip through as a real price
          return true;
        },
        cellClassRules: { "cell-bad": bad("price") },
      },
      { field: "currency", headerName: "Cur.", editable: true, flex: 0.6, minWidth: 66, cellClassRules: { "cell-bad": bad("currency") } },
      {
        field: "stock",
        headerName: "Stock",
        editable: true,
        type: "rightAligned",
        flex: 0.8,
        minWidth: 92,
        valueParser: (p) => (String(p.newValue).trim() === "" ? NaN : Number(p.newValue)),
        cellClassRules: { "cell-bad": bad("stock") },
      },
      {
        colId: "del",
        headerName: "",
        width: 56,
        sortable: false,
        filter: false,
        editable: false,
        resizable: false,
        suppressMovable: true,
        pinned: "right",
        lockPinned: true,
        cellClass: "cell-actions",
        cellRenderer: DeleteCell,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [problems],
  );

  return (
    <div className="grid-box grid-box-setup" style={{ height: gridHeight(rows.length) }}>
      <AgGridReact<DraftRow>
        theme={quoteloomGridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        context={{ onDelete } satisfies Ctx}
        defaultColDef={{ sortable: false, resizable: true, suppressHeaderMenuButton: true }}
        rowHeight={ROW_HEIGHT}
        headerHeight={HEADER_HEIGHT}
        getRowId={(p) => p.data._id}
        singleClickEdit
        tooltipShowDelay={400}
        stopEditingWhenCellsLoseFocus
        onCellValueChanged={(e) => e.data && onChange({ ...e.data })}
        overlayNoRowsTemplate="No products left. Add a row or start over."
      />
    </div>
  );
}
