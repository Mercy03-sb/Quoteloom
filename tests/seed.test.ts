import { describe, expect, it } from "vitest";
import { seed } from "@/lib/seed";
import { DEMO_PRODUCTS } from "@/lib/seed-data";
import { seededDb } from "./helpers";

const count = (db: ReturnType<typeof seededDb>["db"], table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("seed", () => {
  it("creates exactly one demo shop with its products", () => {
    const { db } = seededDb();
    expect(count(db, "shops")).toBe(1);
    expect(count(db, "products")).toBe(DEMO_PRODUCTS.length);
  });

  it("is idempotent and wipes runtime state", () => {
    const { db, shop } = seededDb();
    db.prepare("INSERT INTO search_log (shop_id, query, results_count) VALUES (?, 'x', 0)").run(shop.id);
    seed(db, { demoHistory: false });
    expect(count(db, "shops")).toBe(1);
    expect(count(db, "products")).toBe(DEMO_PRODUCTS.length);
    expect(count(db, "search_log")).toBe(0);
  });

  it("uses unique SKUs and positive integer prices", () => {
    const skus = new Set(DEMO_PRODUCTS.map((p) => p.sku));
    expect(skus.size).toBe(DEMO_PRODUCTS.length);
    for (const p of DEMO_PRODUCTS) expect(Number.isInteger(p.price_cents) && p.price_cents > 0).toBe(true);
  });
});
