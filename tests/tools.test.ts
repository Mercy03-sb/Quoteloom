import { describe, expect, it } from "vitest";
import { resolveBaseUrl } from "@/lib/base-url";
import { callShopTool, parseIntent } from "@/lib/chat";
import { devRoutesEnabled } from "@/lib/config";
import { handleMcpRequest } from "@/lib/mcp";
import { QUOTE_TTL_MS } from "@/lib/quote";
import { seededDb } from "./helpers";

const BASE = "http://localhost:3000";

describe("MCP buying tools", () => {
  it("runs quote -> checkout -> status end to end", async () => {
    const { db, shop } = seededDb();
    const quote = await callShopTool(db, shop, "request_quote", { sku: "LT-THROW-COT-NAT", qty: 1 }, BASE);
    expect(quote.isError).toBe(false);
    expect(quote.result).toMatchObject({ unit_price: "89.00", total: "89.00", currency: "USD" });
    expect(JSON.stringify(quote.result)).not.toMatch(/cost/);

    const co = await callShopTool(db, shop, "create_checkout", { quote_id: quote.result.quote_id }, BASE);
    expect(co.isError).toBe(false);
    expect(String(co.result.approval_url)).toContain("/checkout/");

    const st = await callShopTool(db, shop, "get_order_status", { order_id: co.result.order_id }, BASE);
    expect(st.result).toMatchObject({ status: "CREATED", total: "89.00" });
  });
  it("returns readable tool errors", async () => {
    const { db, shop } = seededDb();
    expect((await callShopTool(db, shop, "request_quote", { sku: "NOPE", qty: 1 }, BASE)).result).toMatchObject({
      error: "unknown_sku",
    });
    expect((await callShopTool(db, shop, "create_checkout", { quote_id: "q_x" }, BASE)).result).toMatchObject({
      error: "unknown_quote",
    });
    expect((await callShopTool(db, shop, "get_order_status", { order_id: "ord_x" }, BASE)).result).toMatchObject({
      error: "unknown_order",
    });
  });
  it("create_checkout rejects a tampered and a time-shifted quote", async () => {
    const { db, shop } = seededDb();
    const a = await callShopTool(db, shop, "request_quote", { sku: "LT-TOTE-CANVAS", qty: 1 }, BASE);
    db.prepare("UPDATE quotes SET price_cents = 1 WHERE id = ?").run(a.result.quote_id);
    expect((await callShopTool(db, shop, "create_checkout", { quote_id: a.result.quote_id }, BASE)).result).toMatchObject({
      error: "bad_signature",
    });

    const b = await callShopTool(db, shop, "request_quote", { sku: "LT-TOTE-CANVAS", qty: 1 }, BASE);
    const past = new Date(Date.now() - QUOTE_TTL_MS - 1000).toISOString();
    db.prepare("UPDATE quotes SET expires_at = ? WHERE id = ?").run(past, b.result.quote_id);
    expect((await callShopTool(db, shop, "create_checkout", { quote_id: b.result.quote_id }, BASE)).isError).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });
  it("lists the new tools", async () => {
    const { db, shop } = seededDb();
    const res = await handleMcpRequest(
      db,
      shop,
      new Request(`${BASE}/m/loom-and-thread/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    const names = (await res.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_products", "request_quote", "create_checkout", "get_order_status"]),
    );
  });
});

describe("parseIntent", () => {
  it("routes common phrases", () => {
    expect(parseIntent("wool scarf")).toEqual({ type: "search", query: "wool scarf" });
    expect(parseIntent("find me nothing")).toMatchObject({ type: "search" });
    expect(parseIntent("quote 2 lt-scarf-wool-gry")).toEqual({ type: "quote", sku: "LT-SCARF-WOOL-GRY", qty: 2 });
    expect(parseIntent("I want LT-TOTE-CANVAS")).toEqual({ type: "quote", sku: "LT-TOTE-CANVAS", qty: 1 });
    expect(parseIntent("buy")).toEqual({ type: "checkout" });
    expect(parseIntent("status")).toEqual({ type: "status" });
    expect(parseIntent("  ")).toEqual({ type: "help" });
  });
});

describe("resolveBaseUrl", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
  it("builds an absolute URL from the request host", () => {
    expect(resolveBaseUrl(h({ host: "localhost:3000" }), {})).toBe("http://localhost:3000");
    expect(resolveBaseUrl(h({ host: "quoteloom.onrender.com" }), {})).toBe("https://quoteloom.onrender.com");
    expect(
      resolveBaseUrl(h({ host: "internal:10000", "x-forwarded-host": "q.example.org", "x-forwarded-proto": "https" }), {}),
    ).toBe("https://q.example.org");
  });
  it("falls back to NEXT_PUBLIC_BASE_URL, then localhost", () => {
    expect(resolveBaseUrl(h({}), { NEXT_PUBLIC_BASE_URL: "https://shop.test/" })).toBe("https://shop.test");
    expect(resolveBaseUrl(undefined, {})).toBe("http://localhost:3000");
  });
  it("ignores a malformed host header", () => {
    expect(resolveBaseUrl(h({ host: "evil.com/x?y" }), { NEXT_PUBLIC_BASE_URL: "https://ok.test" })).toBe("https://ok.test");
  });
});

describe("devRoutesEnabled", () => {
  it("is on outside production, off in production unless ALLOW_DEV_ROUTES=1", () => {
    expect(devRoutesEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(devRoutesEnabled({})).toBe(true);
    expect(devRoutesEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(devRoutesEnabled({ NODE_ENV: "production", ALLOW_DEV_ROUTES: "0" })).toBe(false);
    expect(devRoutesEnabled({ NODE_ENV: "production", ALLOW_DEV_ROUTES: "1" })).toBe(true);
  });
});
