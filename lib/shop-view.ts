import type { CatalogRow } from "@/components/catalog/types";
import { listProducts, type Shop } from "./catalog";
import { getDb, type DB } from "./db";
import { visibleShops } from "./workspace";

export type ActiveShop = { shop: Shop; shops: Shop[]; rows: CatalogRow[]; db: DB };

/**
 * The shop a page should show for this workspace: `slug` if the workspace may see it, else its newest
 * own shop, else the shared demo shop. Null when the DB has no shops at all.
 */
export function loadActiveShop(workspaceId: string | null, slug?: string): ActiveShop | null {
  const db = getDb();
  const shops = visibleShops(db, workspaceId);
  const shop = shops.find((s) => s.slug === slug) ?? shops[0];
  if (!shop) return null;
  const rows = listProducts(db, shop.id).map(({ sku, title, description, price_cents, currency, stock, attrs_json }) => {
    const a = JSON.parse(attrs_json || "{}") as Record<string, unknown>;
    const attrs: CatalogRow["attrs"] = {};
    if (typeof a.material === "string") attrs.material = a.material;
    if (typeof a.color === "string") attrs.color = a.color;
    return { sku, title, description, price_cents, currency, stock, attrs };
  });
  return { shop, shops, rows, db };
}
