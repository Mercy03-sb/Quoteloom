import type { DB } from "./db";

export type ShopStats = {
  products: number;
  unitsInStock: number;
  inventoryValueCents: number;
  outOfStock: number;
  searches: number;
  zeroResultSearches: number;
};

/** Numbers for the dashboard header cards. Plain SQL, no money decisions here. */
export function getShopStats(db: DB, shopId: number): ShopStats {
  const p = db
    .prepare(
      `SELECT COUNT(*) AS products,
              COALESCE(SUM(stock), 0) AS units,
              COALESCE(SUM(stock * price_cents), 0) AS value,
              COALESCE(SUM(stock = 0), 0) AS oos
         FROM products WHERE shop_id = ?`,
    )
    .get(shopId) as { products: number; units: number; value: number; oos: number };
  const s = db
    .prepare(
      `SELECT COUNT(*) AS searches, COALESCE(SUM(results_count = 0), 0) AS zero
         FROM search_log WHERE shop_id = ?`,
    )
    .get(shopId) as { searches: number; zero: number };
  return {
    products: p.products,
    unitsInStock: p.units,
    inventoryValueCents: p.value,
    outOfStock: p.oos,
    searches: s.searches,
    zeroResultSearches: s.zero,
  };
}
