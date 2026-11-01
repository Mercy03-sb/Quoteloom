import { headers } from "next/headers";
import Link from "next/link";
import { CopyButton } from "@/components/catalog/CopyButton";
import { ProductCard } from "@/components/catalog/ProductCard";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatCents } from "@/lib/catalog";
import { mcpUrl, resolveBaseUrl } from "@/lib/base-url";
import { getShopStats } from "@/lib/dashboard";
import { loadPrimaryShop } from "@/lib/shop-view";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const data = loadPrimaryShop();
  if (!data) {
    return (
      <div className="page">
        <EmptyState title="No shop yet">
          Run <code>npm run seed</code> to restore the demo shop.
        </EmptyState>
      </div>
    );
  }
  const { shop, rows, db } = data;
  const stats = getShopStats(db, shop.id);
  const endpoint = mcpUrl(resolveBaseUrl(await headers()), shop.slug);

  return (
    <div className="page">
      <Card hero>
        <div className="row" style={{ marginBottom: "var(--sp-3)" }}>
          <Badge tone="accent">Your storefront</Badge>
        </div>
        <h1>{shop.name}</h1>
        <p style={{ color: "var(--c-text-muted)", margin: "var(--sp-2) 0 var(--sp-5)", maxWidth: "58ch" }}>
          Buyer agents search this catalog, get signed quotes, and pay through PayPal sandbox. Point an MCP client at the
          endpoint below.
        </p>
        <div className="endpoint">
          <code>{endpoint}</code>
          <CopyButton text={endpoint} label="Copy URL" />
        </div>
      </Card>

      <div className="stats">
        <Card flat>
          <div className="stat-label">Products</div>
          <div className="stat-value">{stats.products}</div>
          <div className="stat-note">{stats.outOfStock} out of stock</div>
        </Card>
        <Card flat>
          <div className="stat-label">Units in stock</div>
          <div className="stat-value">{stats.unitsInStock}</div>
          <div className="stat-note">Across the whole catalog</div>
        </Card>
        <Card flat>
          <div className="stat-label">Inventory value</div>
          <div className="stat-value">${formatCents(stats.inventoryValueCents)}</div>
          <div className="stat-note">At list price</div>
        </Card>
        <Card flat>
          <div className="stat-label">Agent searches</div>
          <div className="stat-value">{stats.searches}</div>
          <div className="stat-note">{stats.zeroResultSearches} found nothing</div>
        </Card>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        <div className="page-head">
          <h2>Featured products</h2>
          <Link className="btn btn-secondary btn-sm" href="/catalog">
            Open full catalog
          </Link>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No products yet">Products you add will appear here.</EmptyState>
        ) : (
          <div className="catalog-grid">
            {rows.slice(0, 4).map((p) => (
              <ProductCard key={p.sku} product={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
