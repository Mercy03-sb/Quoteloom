"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import { formatCents } from "@/lib/catalog";
import type { CatalogRow } from "./types";

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid theme driven by the same CSS variables as the rest of the app (follows light/dark). */
export const quoteloomGridTheme = themeQuartz.withParams({
  accentColor: "var(--c-accent)",
  backgroundColor: "var(--c-surface)",
  foregroundColor: "var(--c-text)",
  headerBackgroundColor: "var(--c-surface-2)",
  headerTextColor: "var(--c-text-muted)",
  borderColor: "var(--c-border)",
  oddRowBackgroundColor: "var(--c-surface)",
  rowHoverColor: "var(--c-accent-soft)",
  selectedRowBackgroundColor: "var(--c-accent-soft)",
  fontFamily: "var(--f-body)",
  headerFontFamily: "var(--f-body)",
  headerFontWeight: 600,
  fontSize: 14,
  spacing: 8,
  borderRadius: 10,
  wrapperBorderRadius: 16,
  browserColorScheme: "inherit",
});

export function CatalogGrid({ rows }: { rows: CatalogRow[] }) {
  const columnDefs = useMemo<ColDef<CatalogRow>[]>(
    () => [
      { field: "sku", headerName: "SKU", minWidth: 190, cellStyle: { fontFamily: "var(--f-mono)", fontSize: 13 } },
      { field: "title", headerName: "Product", flex: 2, minWidth: 220 },
      {
        field: "price_cents",
        headerName: "Price",
        type: "rightAligned",
        minWidth: 110,
        valueFormatter: (p) => (p.value == null ? "" : `${formatCents(p.value)} ${p.data?.currency ?? ""}`),
      },
      { field: "stock", headerName: "Stock", type: "rightAligned", minWidth: 100 },
    ],
    [],
  );

  return (
    <div className="grid-box">
      <AgGridReact<CatalogRow>
        theme={quoteloomGridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, filter: true, resizable: true, suppressHeaderMenuButton: true }}
        getRowId={(p) => p.data.sku}
        overlayNoRowsTemplate="No products match this filter."
        pagination={rows.length > 25}
      />
    </div>
  );
}
