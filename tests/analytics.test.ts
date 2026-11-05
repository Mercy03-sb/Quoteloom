import { describe, expect, it } from "vitest";
import { dataCounts, disputesList, salesByDay, searchesByAgent, searchesByDay, unmetDemand, withSuggestions } from "@/lib/analytics";
import { seedDemoHistory } from "@/lib/demo-history";
import { listOrders } from "@/lib/orders-view";
import { listDisputes, loadDispute } from "@/lib/disputes";
import { loadOrder } from "@/lib/orders";
import { seed } from "@/lib/seed";
import { DEMO_UNMET_QUERIES } from "@/lib/seed-data";
import { seededDb } from "./helpers";

const n = (db: ReturnType<typeof seededDb>["db"], t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe("demo history seed", () => {
  it("is idempotent: re-running (and re-seeding) gives identical counts", () => {
    const { db, shop } = seededDb();
    const a = seedDemoHistory(db, shop.id);
    const counts = [n(db, "orders"), n(db, "search_log"), n(db, "disputes")];
    seedDemoHistory(db, shop.id);
    expect([n(db, "orders"), n(db, "search_log"), n(db, "disputes")]).toEqual(counts);
    seed(db); // a boot
    expect([n(db, "orders"), n(db, "search_log"), n(db, "disputes")]).toEqual(counts);
    expect(a.orders).toBeGreaterThan(20);
    expect(a.disputes).toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE is_demo = 0").get()).toEqual({ n: 0 });
  });

  it("keeps demo rows out of real order, dispute and PayPal flows", () => {
    const { db, shop } = seededDb();
    seedDemoHistory(db, shop.id);
    expect(listOrders(db, [shop.id])).toEqual([]);
    expect(listDisputes(db, [shop.id])).toEqual([]);
    const o = db.prepare("SELECT id FROM orders LIMIT 1").get() as { id: string };
    const d = db.prepare("SELECT id FROM disputes LIMIT 1").get() as { id: string };
    expect(loadOrder(db, o.id)).toBeUndefined();
    expect(loadDispute(db, d.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE is_demo = 1 AND (paypal_order_id IS NOT NULL OR quote_id IS NOT NULL)").get()).toEqual({ n: 0 });
  });
});

describe("analytics queries", () => {
  it("are empty on a shop with no history", () => {
    const { db, shop } = seededDb();
    expect(salesByDay(db, shop.id)).toEqual([]);
    expect(searchesByDay(db, shop.id)).toEqual([]);
    expect(unmetDemand(db, shop.id)).toEqual([]);
    expect(disputesList(db, shop.id)).toEqual([]);
  });

  it("sales, traffic, agents, unmet demand and disputes from the demo history", () => {
    const { db, shop } = seededDb();
    seedDemoHistory(db, shop.id);
    const sales = salesByDay(db, shop.id);
    expect(sales.length).toBeGreaterThan(15);
    expect(sales.every((s) => s.demo === s.orders)).toBe(true);
    expect(searchesByDay(db, shop.id).reduce((a, d) => a + d.searches, 0)).toBe(dataCounts(db, shop.id).searches);
    expect(searchesByAgent(db, shop.id).length).toBeGreaterThanOrEqual(4);
    const unmet = unmetDemand(db, shop.id);
    expect(unmet.length).toBeGreaterThan(5);
    expect(unmet.every((u) => u.zero + u.weak === u.searches)).toBe(true);
    expect(DEMO_UNMET_QUERIES).toContain(unmet.find((u) => u.zero > 0)!.query);
    expect(disputesList(db, shop.id).length).toBeGreaterThanOrEqual(2);
    expect(dataCounts(db, shop.id).demo_orders).toBe(dataCounts(db, shop.id).orders);
  });

  it("groups unmet searches by normalised query and ignores queries that found results", () => {
    const { db, shop } = seededDb();
    const add = db.prepare("INSERT INTO search_log (shop_id, query, results_count, agent_id) VALUES (?, ?, ?, ?)");
    add.run(shop.id, "Ceramic  Mug", 0, "a");
    add.run(shop.id, "ceramic mug!", 0, "b");
    add.run(shop.id, "scarf", 3, "a");
    const u = unmetDemand(db, shop.id);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ query: "ceramic mug", searches: 2, agents: 2, zero: 2 });
  });

  it("suggestions come from the snapshot with the key unset and carry no offer URL", async () => {
    const { db, shop } = seededDb();
    seedDemoHistory(db, shop.id);
    const rows = await withSuggestions(db, unmetDemand(db, shop.id), { env: {} });
    const withData = rows.filter((r) => r.suggestions.length);
    expect(withData.length).toBeGreaterThan(0);
    expect(withData[0].source).toBe("snapshot");
    expect(JSON.stringify(rows)).not.toContain("buy.trychannel3.com");
  });
});
