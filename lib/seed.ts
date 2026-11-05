import type { DB } from "./db";
import { TABLES } from "./schema";
import { seedDemoHistory } from "./demo-history";
import { DEMO_PRODUCTS, DEMO_SHOP } from "./seed-data";

/** Wipe all tables and restore the demo state. Idempotent. */
export function seed(db: DB, opts: { demoHistory?: boolean } = {}): { shops: number; products: number } {
  const run = db.transaction(() => {
    for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
    const shop = db
      .prepare("INSERT INTO shops (slug, name, source_url, rules_json) VALUES (?, ?, ?, ?)")
      .run(DEMO_SHOP.slug, DEMO_SHOP.name, DEMO_SHOP.source_url, JSON.stringify(DEMO_SHOP.rules));
    const insert = db.prepare(
      `INSERT INTO products (shop_id, sku, title, description, price_cents, currency, stock, attrs_json)
       VALUES (?, ?, ?, ?, ?, 'USD', ?, ?)`,
    );
    for (const p of DEMO_PRODUCTS) {
      insert.run(shop.lastInsertRowid, p.sku, p.title, p.description, p.price_cents, p.stock, JSON.stringify(p.attrs));
    }
    if (opts.demoHistory !== false) seedDemoHistory(db, Number(shop.lastInsertRowid));
    db.prepare("INSERT INTO events (type, payload_json) VALUES (?, ?)").run(
      "seed",
      JSON.stringify({ shop: DEMO_SHOP.slug, products: DEMO_PRODUCTS.length }),
    );
  });
  run();
  return { shops: 1, products: DEMO_PRODUCTS.length };
}
