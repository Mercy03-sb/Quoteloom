import { beforeEach, describe, expect, it } from "vitest";
import { callShopTool } from "@/lib/chat";
import { resetChannel3State, type C3Product } from "@/lib/channel3";
import { computeMarket, marketFromTranscript, publicMarket } from "@/lib/market";
import { issueQuoteDrafted } from "@/lib/quote";
import { inspectQuote } from "@/lib/quote";
import { seededDb } from "./helpers";

const p = (price: number, over: Partial<C3Product> = {}): C3Product => ({
  title: "Item", image: null, retailer: "r.example", price, currency: "USD", in_stock: true, url: "https://buy.trychannel3.com/secret", ...over,
});

beforeEach(() => {
  resetChannel3State();
  delete process.env.CHANNEL3_API_KEY; // tests never go live
});

describe("computeMarket", () => {
  it("median, low, high of in-stock offers in the shop currency", () => {
    const m = computeMarket({ source: "live", products: [p(40), p(60), p(50), p(99, { in_stock: false }), p(10, { currency: "EUR" })] }, "usd");
    expect(m).toMatchObject({ status: "ok", count: 3, low_cents: 4000, median_cents: 5000, high_cents: 6000, label: "Market reference (via Channel3)" });
  });
  it("needs two usable offers, else limited market data", () => {
    expect(computeMarket({ source: "cached", products: [p(40), p(5, { in_stock: false })] }, "USD").status).toBe("limited");
    expect(computeMarket({ source: "none", products: [] }, "USD").status).toBe("limited");
  });
  it("labels snapshot results", () => {
    expect(computeMarket({ source: "snapshot", products: [p(1), p(2)] }, "USD").label).toContain("snapshot");
  });
  it("public view has no samples and no links", () => {
    const m = computeMarket({ source: "live", products: [p(40), p(60)] }, "USD");
    expect(JSON.stringify(publicMarket(m))).not.toMatch(/trychannel3|samples|"url"/);
  });
});

describe("market reference in negotiation", () => {
  it("is recorded in the decision log for an offer and never changes the price", async () => {
    const { db, shop } = seededDb();
    const input = { sku: "LT-SCARF-WOOL-GRY", qty: 1, offerCents: 3000, agentId: "t1" };
    const withMarket = await issueQuoteDrafted(db, shop, input, { market: { env: {} } });
    expect(withMarket.market).not.toBeNull();
    const info = inspectQuote(db, withMarket.id);
    expect(marketFromTranscript(info!.transcript)?.label).toMatch(/Market reference \(via Channel3/);
    // A different (empty) market gives the same price: policy alone decides.
    const { db: db2, shop: shop2 } = seededDb();
    const q2 = await issueQuoteDrafted(db2, shop2, { ...input, agentId: "t2" }, { market: { env: {}, snapshotFile: "does-not-exist.json" } });
    expect(q2.market?.status).toBe("limited");
    expect(q2.price_cents).toBe(withMarket.price_cents);
  });
  it("no offer, no lookup", async () => {
    const { db, shop } = seededDb();
    const q = await issueQuoteDrafted(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 });
    expect(q.market).toBeNull();
  });
  it("request_quote MCP result carries the reference but leaks no floor, cost or offer URL", async () => {
    const { db, shop } = seededDb();
    const out = await callShopTool(db, shop, "request_quote", { sku: "LT-SCARF-WOOL-GRY", qty: 1, offer_price: 20 }, "http://localhost:3000", { ip: "1.1.1.1", workspace: null });
    expect(out.isError).toBe(false);
    const mr = out.result.market_reference as { label: string; note: string };
    expect(mr.label).toMatch(/^Market reference/);
    expect(mr.note).toMatch(/similar/i);
    const text = JSON.stringify(out.result);
    expect(text).not.toMatch(/trychannel3\.com|floor|cost_cents|"cost"|margin/i);
  });
});
