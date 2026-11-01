"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { EmptyState, Skeleton } from "@/components/ui";
import { ProductCard } from "./ProductCard";
import type { CatalogRow } from "./types";

// AG Grid is browser-only and heavy: load it only when the Table view is opened.
const CatalogGrid = dynamic(() => import("./CatalogGrid").then((m) => m.CatalogGrid), {
  ssr: false,
  loading: () => <Skeleton height={420} />,
});

export function CatalogView({ rows }: { rows: CatalogRow[] }) {
  const [view, setView] = useState<"cards" | "table">("cards");

  if (rows.length === 0) {
    return <EmptyState title="No products yet">Add products with the catalog editor (coming in the next milestone) or reseed the demo with <code>npm run seed</code>.</EmptyState>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="stat-label">{rows.length} products</span>
        <div className="segmented" role="group" aria-label="Catalog view">
          <button type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")}>Cards</button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
        </div>
      </div>
      {view === "cards" ? (
        <div className="catalog-grid">
          {rows.map((p) => (
            <ProductCard key={p.sku} product={p} />
          ))}
        </div>
      ) : (
        <CatalogGrid rows={rows} />
      )}
    </div>
  );
}
