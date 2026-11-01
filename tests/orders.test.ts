import { Client, Environment } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { canTransition, captureCheckout, createCheckout, getOrderStatus, loadOrder, OrderError } from "@/lib/orders";
import { issueQuote, QUOTE_TTL_MS } from "@/lib/quote";
import { seededDb } from "./helpers";

const SECRET = "test-secret";
const BASE = "http://localhost:3000";
const env = {};

function setup(sku = "LT-SCARF-WOOL-GRY", qty = 2) {
  const { db, shop } = seededDb();
  const q = issueQuote(db, shop, { sku, qty }, { secret: SECRET });
  return { db, shop, q };
}
const stock = (db: ReturnType<typeof seededDb>["db"], sku: string) =>
  (db.prepare("SELECT stock FROM products WHERE sku = ?").get(sku) as { stock: number }).stock;

describe("createCheckout", () => {
  it("creates a simulated order for a valid quote", async () => {
    const { db, shop, q } = setup();
    const c = await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env });
    expect(c).toMatchObject({ status: "CREATED", amount_cents: 9600, currency: "USD", mode: "sim" });
    expect(c.approval_url).toBe(`${BASE}/checkout/${c.order_id}`);
    expect(loadOrder(db, c.order_id)?.quote_id).toBe(q.id);
  });
  it("rejects an expired quote and creates no order", async () => {
    const { db, shop, q } = setup();
    const now = new Date(Date.now() + QUOTE_TTL_MS + 1000);
    await expect(createCheckout(db, shop, q.id, BASE, { secret: SECRET, env, now })).rejects.toMatchObject({
      code: "expired",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });
  it("rejects a tampered quote and creates no order", async () => {
    const { db, shop, q } = setup();
    db.prepare("UPDATE quotes SET price_cents = 1 WHERE id = ?").run(q.id);
    await expect(createCheckout(db, shop, q.id, BASE, { secret: SECRET, env })).rejects.toMatchObject({
      code: "bad_signature",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });
  it("rejects a quote signed with another secret", async () => {
    const { db, shop, q } = setup();
    await expect(createCheckout(db, shop, q.id, BASE, { secret: "other", env })).rejects.toMatchObject({
      code: "bad_signature",
    });
  });
  it("allows one order per quote", async () => {
    const { db, shop, q } = setup();
    await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env });
    await expect(createCheckout(db, shop, q.id, BASE, { secret: SECRET, env })).rejects.toMatchObject({
      code: "quote_used",
    });
  });
  it("re-checks stock at checkout", async () => {
    const { db, shop, q } = setup("LT-RUG-WOOL-SM", 3);
    db.prepare("UPDATE products SET stock = 1 WHERE sku = 'LT-RUG-WOOL-SM'").run();
    await expect(createCheckout(db, shop, q.id, BASE, { secret: SECRET, env })).rejects.toMatchObject({
      code: "insufficient_stock",
    });
  });
});

describe("captureCheckout", () => {
  it("marks the order PAID, takes stock, and is idempotent", async () => {
    const { db, shop, q } = setup();
    const before = stock(db, "LT-SCARF-WOOL-GRY");
    const c = await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env });
    const paid = await captureCheckout(db, c.order_id, { env });
    expect(paid.status).toBe("PAID");
    expect(paid.captured_at).toBeTruthy();
    expect(stock(db, "LT-SCARF-WOOL-GRY")).toBe(before - 2);
    await captureCheckout(db, c.order_id, { env });
    expect(stock(db, "LT-SCARF-WOOL-GRY")).toBe(before - 2);
    expect(getOrderStatus(db, shop, c.order_id)).toMatchObject({ status: "PAID", total: "96.00", qty: 2 });
  });
  it("refuses unknown orders and sold-out products", async () => {
    const { db, shop, q } = setup("LT-RUG-WOOL-SM", 2);
    await expect(captureCheckout(db, "ord_missing", { env })).rejects.toMatchObject({ code: "unknown_order" });
    const c = await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env });
    db.prepare("UPDATE products SET stock = 0 WHERE sku = 'LT-RUG-WOOL-SM'").run();
    await expect(captureCheckout(db, c.order_id, { env })).rejects.toMatchObject({ code: "capture_failed" });
    expect(loadOrder(db, c.order_id)?.status).toBe("CREATED");
  });
  it("fails the order when PayPal captures a different amount", async () => {
    const { db, shop, q } = setup();
    const c = await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env });
    const client = new Client({
      environment: Environment.Sandbox,
      clientCredentialsAuthCredentials: {
        oAuthClientId: "id",
        oAuthClientSecret: "s",
        oAuthToken: { accessToken: "t", tokenType: "Bearer", expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) },
      },
      httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
      unstable_httpClientOptions: {
        adapter: async (config: any) => ({
          data: JSON.stringify({
            id: "X",
            status: "COMPLETED",
            purchase_units: [
              { payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } },
            ],
          }),
          status: 201,
          statusText: "",
          headers: { "content-type": "application/json" },
          config,
        }),
      },
    });
    await expect(captureCheckout(db, c.order_id, { env, client })).rejects.toMatchObject({ code: "amount_mismatch" });
    expect(loadOrder(db, c.order_id)?.status).toBe("FAILED");
  });
});

describe("getOrderStatus", () => {
  it("is scoped to the shop and hides unknown orders", async () => {
    const { db, shop, q } = setup();
    const c = await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env });
    expect(() => getOrderStatus(db, { ...shop, id: 99 }, c.order_id)).toThrow(OrderError);
    expect(() => getOrderStatus(db, shop, "ord_missing")).toThrowError(expect.objectContaining({ code: "unknown_order" }));
  });
});

describe("canTransition", () => {
  it("only moves forward", () => {
    expect(canTransition("CREATED", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "PAID")).toBe(true);
    expect(canTransition("PAID", "REFUNDED")).toBe(true);
    expect(canTransition("PAID", "APPROVED")).toBe(false);
    expect(canTransition("PAID", "FAILED")).toBe(false);
    expect(canTransition("REFUNDED", "PAID")).toBe(false);
  });
});
