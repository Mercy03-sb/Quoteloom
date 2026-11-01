import type { CatalogRow } from "@/components/catalog/types";
import { listProducts, type Shop } from "./catalog";
import { getDb, type DB } from "./db";

/** First shop plus its catalog rows (the demo has one shop). Null when the DB has no shops. */
export function loadPrimaryShop(): { shop: Shop; rows: CatalogRow[]; db: DB } | null {
  const db = getDb();
  const shop = db.prepare("SELECT id, slug, name, source_url FROM shops ORDER BY id LIMIT 1").get() as Shop | undefined;
  if (!shop) return null;
  const rows = listProducts(db, shop.id).map(({ sku, title, description, price_cents, currency, stock }) => ({
    sku,
    title,
    description,
    price_cents,
    currency,
    stock,
  }));
  return { shop, rows, db };
}
