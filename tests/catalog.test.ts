import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, searchProducts, tokenize } from "@/lib/catalog";
import { DEMO_PRODUCTS } from "@/lib/seed-data";
import { seededDb } from "./helpers";

describe("tokenize", () => {
  it("lowercases, splits and strips simple plurals", () => {
    expect(tokenize("Linen Towels, 3-pack!")).toEqual(["linen", "towel", "pack"]);
  });
});

describe("searchProducts", () => {
  it("ranks products matching more keywords first", () => {
    const { db, shop } = seededDb();
    const results = searchProducts(db, shop, { query: "wool scarf" });
    expect(results.slice(0, 2).map((r) => r.sku).sort()).toEqual(["LT-SCARF-WOOL-GRY", "LT-SCARF-WOOL-RED"]);
    expect(results[0].price).toBe("48.00");
  });

  it("filters by max_price in major units", () => {
    const { db, shop } = seededDb();
    const results = searchProducts(db, shop, { query: "linen", max_price: 30 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.price_cents).toBeLessThanOrEqual(3000);
  });

  it("applies the default and the requested limit", () => {
    const { db, shop } = seededDb();
    expect(searchProducts(db, shop, { query: "" })).toHaveLength(Math.min(DEFAULT_LIMIT, DEMO_PRODUCTS.length));
    expect(searchProducts(db, shop, { query: "", limit: 2 })).toHaveLength(2);
  });

  it("returns nothing for an unknown item", () => {
    const { db, shop } = seededDb();
    expect(searchProducts(db, shop, { query: "titanium bicycle" })).toEqual([]);
  });

  it("logs every search, including zero-result ones, to search_log", () => {
    const { db, shop } = seededDb();
    searchProducts(db, shop, { query: "scarf" }, "agent-a");
    searchProducts(db, shop, { query: "titanium bicycle" }, "agent-b");
    const rows = db.prepare("SELECT query, results_count, agent_id FROM search_log ORDER BY id").all();
    expect(rows).toEqual([
      { query: "scarf", results_count: 2, agent_id: "agent-a" },
      { query: "titanium bicycle", results_count: 0, agent_id: "agent-b" },
    ]);
  });
});
