import { describe, expect, it } from "vitest";
import { searchProducts } from "@/lib/catalog";
import { getShopStats } from "@/lib/dashboard";
import { DEMO_PRODUCTS } from "@/lib/seed-data";
import { seededDb } from "./helpers";

describe("getShopStats", () => {
  it("summarises the seeded catalog", () => {
    const { db, shop } = seededDb();
    const s = getShopStats(db, shop.id);
    expect(s.products).toBe(DEMO_PRODUCTS.length);
    expect(s.inventoryValueCents).toBe(DEMO_PRODUCTS.reduce((n, p) => n + p.price_cents * p.stock, 0));
    expect(s.unitsInStock).toBe(DEMO_PRODUCTS.reduce((n, p) => n + p.stock, 0));
  });

  it("counts searches and zero-result searches", () => {
    const { db, shop } = seededDb();
    const before = getShopStats(db, shop.id);
    searchProducts(db, shop, { query: "zzzz-nothing-matches" });
    searchProducts(db, shop, { query: "scarf" });
    const after = getShopStats(db, shop.id);
    expect(after.searches).toBe(before.searches + 2);
    expect(after.zeroResultSearches).toBe(before.zeroResultSearches + 1);
  });
});
