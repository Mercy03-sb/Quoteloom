"use client";

import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type { CellClassParams, ColDef, ValueSetterParams } from "ag-grid-community";
import { useMemo } from "react";
import { quoteloomGridTheme } from "@/components/catalog/CatalogGrid";
import { formatCents } from "@/lib/catalog";
import { findProblems, parsePriceToCents, type DraftProduct, type ProblemField } from "@/lib/ingest/draft";

export type DraftRow = DraftProduct & { _id: string };
type Ctx = { onDelete: (id: string) => void };

function DeleteCell(props: CustomCellRendererProps<DraftRow, unknown, Ctx>) {
  const row = props.data;
  if (!row) return null;
  return (
    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Delete ${row.title || "this row"}`} onClick={() => props.context.onDelete(row._id)}>
      Delete
    </button>
  );
}

/** Editable draft catalog. Edits flow back through onChange; invalid cells are outlined and block Publish. */
export function ReviewGrid({ rows, onChange, onDelete }: { rows: DraftRow[]; onChange: (row: DraftRow) => void; onDelete: (id: string) => void }) {
  const problems = useMemo(() => findProblems(rows), [rows]);
  const bad = (field: ProblemField) => (p: CellClassParams<DraftRow>) => Boolean(p.data && problems[p.data._id]?.includes(field));

  const columnDefs = useMemo<ColDef<DraftRow>[]>(
    () => [
      { field: "sku", headerName: "SKU", editable: true, minWidth: 150, cellClassRules: { "cell-bad": bad("sku") }, cellStyle: { fontFamily: "var(--f-mono)", fontSize: 13 } },
      { field: "title", headerName: "Product", editable: true, flex: 2, minWidth: 220, cellClassRules: { "cell-bad": bad("title") } },
      { field: "description", headerName: "Description", editable: true, flex: 3, minWidth: 240 },
      {
        colId: "price",
        headerName: "Price",
        editable: true,
        type: "rightAligned",
        minWidth: 110,
        valueGetter: (p) => (p.data && p.data.price_cents > 0 ? formatCents(p.data.price_cents) : ""),
        valueSetter: (p: ValueSetterParams<DraftRow>) => {
          const cents = parsePriceToCents(p.newValue);
          p.data.price_cents = cents ?? 0; // 0 is flagged, so a typo cannot slip through as a real price
          return true;
        },
        cellClassRules: { "cell-bad": bad("price") },
      },
      { field: "currency", headerName: "Cur.", editable: true, minWidth: 80, maxWidth: 100, cellClassRules: { "cell-bad": bad("currency") } },
      {
        field: "stock",
        headerName: "Stock",
        editable: true,
        type: "rightAligned",
        minWidth: 90,
        maxWidth: 110,
        valueParser: (p) => (String(p.newValue).trim() === "" ? NaN : Number(p.newValue)),
        cellClassRules: { "cell-bad": bad("stock") },
      },
      { colId: "del", headerName: "", sortable: false, filter: false, editable: false, width: 100, pinned: "right", cellRenderer: DeleteCell },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [problems],
  );

  return (
    <div className="grid-box grid-box-setup">
      <AgGridReact<DraftRow>
        theme={quoteloomGridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        context={{ onDelete } satisfies Ctx}
        defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true }}
        getRowId={(p) => p.data._id}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        onCellValueChanged={(e) => e.data && onChange({ ...e.data })}
        overlayNoRowsTemplate="No products left. Add a row or start over."
      />
    </div>
  );
}
