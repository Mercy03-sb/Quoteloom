import { Client, Environment } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { callShopTool } from "@/lib/chat";
import { captureCheckout, createCheckout, getOrderStatus, loadOrder } from "@/lib/orders";
import { SIM_SIGNATURE_HEADER, simWebhookSignature } from "@/lib/paypal";
import { issueQuote } from "@/lib/quote";
import { handlePaypalWebhook, simWebhookSecret } from "@/lib/webhook";
import { seededDb } from "./helpers";

const SECRET = "capture-secret";
const BASE = "http://localhost:3000";
const env = {};
const SKU = "LT-SCARF-WOOL-GRY";

/** A PayPal client whose capture endpoint is stubbed; `calls` counts capture requests that reached "PayPal". */
function stubClient(amount: string, opts: { status?: number } = {}) {
  const calls = { capture: 0 };
  const client = new Client({
    environment: Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: "id",
      oAuthClientSecret: "s",
      oAuthToken: { accessToken: "t", tokenType: "Bearer", expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) },
    },
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    unstable_httpClientOptions: {
      adapter: async (config: any) => {
        calls.capture += 1;
        await new Promise((r) => setTimeout(r, 5)); // widen the race window
        const status = opts.status ?? 201;
        return {
          data: JSON.stringify(
            status === 201
              ? { id: "X", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED", amount: { currency_code: "USD", value: amount } }] } }] }
              : { name: "UNPROCESSABLE_ENTITY" },
          ),
          status,
          statusText: "",
          headers: { "content-type": "application/json" },
          config,
        };
      },
    },
  });
  return { client, calls };
}

async function newOrder(qty = 2) {
  const { db, shop } = seededDb();
  const q = issueQuote(db, shop, { sku: SKU, qty }, { secret: SECRET });
  const c = await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env });
  const total = (c.amount_cents / 100).toFixed(2);
  const stock = () => (db.prepare("SELECT stock FROM products WHERE sku = ?").get(SKU) as { stock: number }).stock;
  return { db, shop, c, total, stock, stockBefore: stock() };
}

function send(db: Parameters<typeof handlePaypalWebhook>[0], event: object, client?: Client) {
  const raw = JSON.stringify(event);
  const headers = new Headers({ [SIM_SIGNATURE_HEADER]: simWebhookSignature(raw, simWebhookSecret(env)) });
  return handlePaypalWebhook(db, raw, headers, { env, client });
}
const approved = (id: string, paypalOrderId: string) => ({ id, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: paypalOrderId } });
const captureDone = (id: string, paypalOrderId: string, value: string) => ({
  id,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP-1", amount: { value, currency_code: "USD" }, supplementary_data: { related_ids: { order_id: paypalOrderId } } },
});
const captures = (db: ReturnType<typeof seededDb>["db"]) => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'order.captured'").get() as { n: number }).n;

describe("PayPal return URL", () => {
  it("sends the buyer back to the public receipt, not the merchant checkout page", async () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: SKU, qty: 1 }, { secret: SECRET });
    // sandbox create with a stubbed client; record the request body the SDK sends
    const seen: string[] = [];
    const spy = new Client({
      environment: Environment.Sandbox,
      clientCredentialsAuthCredentials: {
        oAuthClientId: "id",
        oAuthClientSecret: "s",
        oAuthToken: { accessToken: "t", tokenType: "Bearer", expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) },
      },
      httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
      unstable_httpClientOptions: {
        adapter: async (config: any) => {
          seen.push(String(config.data));
          return {
            data: JSON.stringify({ id: "PP-1", status: "CREATED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=PP-1" }] }),
            status: 201, statusText: "", headers: { "content-type": "application/json" }, config,
          };
        },
      },
    });
    const c = await createCheckout(db, shop, q.id, BASE, { secret: SECRET, env, client: spy });
    const body = JSON.parse(seen[0]) as { application_context: { return_url: string; cancel_url: string } };
    const returnUrl = body.application_context.return_url;
    expect(returnUrl).toBe(`${BASE}/receipt/${c.order_id}?paypal=return`);
    expect(body.application_context.cancel_url).toBe(`${BASE}/receipt/${c.order_id}?paypal=cancel`);
    expect(returnUrl).not.toContain("/checkout/");
  });
});

describe("path A: the buyer returns (return handler captures)", () => {
  it("captures once, marks PAID, takes stock once, and get_order_status says PAID", async () => {
    const { db, shop, c, total, stock, stockBefore } = await newOrder();
    const { client, calls } = stubClient(total);
    const paid = await captureCheckout(db, c.order_id, { env, client });
    expect(paid.status).toBe("PAID");
    expect(calls.capture).toBe(1);
    expect(stockBefore - stock()).toBe(2);
    expect(getOrderStatus(db, shop, c.order_id).status).toBe("PAID");
    const viaMcp = await callShopTool(db, shop, "get_order_status", { order_id: c.order_id }, BASE);
    expect(viaMcp.result.status).toBe("PAID");
  });

  it("a second return (page reload) does not capture again", async () => {
    const { db, c, total, stock, stockBefore } = await newOrder();
    const { client, calls } = stubClient(total);
    await captureCheckout(db, c.order_id, { env, client });
    await captureCheckout(db, c.order_id, { env, client });
    expect(calls.capture).toBe(1);
    expect(stockBefore - stock()).toBe(2);
    expect(captures(db)).toBe(1);
  });
});

describe("path B: the buyer never returns (CHECKOUT.ORDER.APPROVED webhook captures)", () => {
  it("captures on the webhook alone, forward-only, and get_order_status says PAID", async () => {
    const { db, shop, c, total, stock, stockBefore } = await newOrder();
    const { client, calls } = stubClient(total);
    const res = await send(db, approved("EV-1", c.paypal_order_id), client);
    expect(res).toMatchObject({ status: 200, body: { received: true, outcome: "captured" } });
    expect(calls.capture).toBe(1);
    expect(loadOrder(db, c.order_id)).toMatchObject({ status: "PAID" });
    expect(loadOrder(db, c.order_id)?.captured_at).toBeTruthy();
    expect(stockBefore - stock()).toBe(2);
    expect(getOrderStatus(db, shop, c.order_id).status).toBe("PAID");
    expect((await callShopTool(db, shop, "get_order_status", { order_id: c.order_id }, BASE)).result.status).toBe("PAID");
    const statuses = (db.prepare("SELECT payload_json FROM events WHERE type = 'order.status' ORDER BY id").all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json).to);
    expect(statuses).toEqual(["APPROVED", "PAID"]); // forward only
  });

  it("the later PAYMENT.CAPTURE.COMPLETED event changes nothing", async () => {
    const { db, c, total, stock, stockBefore } = await newOrder();
    const { client, calls } = stubClient(total);
    await send(db, approved("EV-2", c.paypal_order_id), client);
    const done = await send(db, captureDone("EV-3", c.paypal_order_id, total), client);
    expect(done.body).toMatchObject({ outcome: "no_change" });
    expect(calls.capture).toBe(1);
    expect(stockBefore - stock()).toBe(2);
  });

  it("a failed capture is recorded, answers 200, leaves the order APPROVED, and the return handler can still finish it", async () => {
    const { db, c, total } = await newOrder();
    const bad = stubClient(total, { status: 422 });
    const res = await send(db, approved("EV-4", c.paypal_order_id), bad.client);
    expect(res.status).toBe(200);
    expect(String(res.body.outcome)).toMatch(/^capture_failed:capture_failed/);
    expect(loadOrder(db, c.order_id)?.status).toBe("APPROVED");
    const good = stubClient(total);
    expect((await captureCheckout(db, c.order_id, { env, client: good.client })).status).toBe("PAID");
  });

  it("an amount mismatch from PayPal fails the order and never marks it PAID", async () => {
    const { db, c } = await newOrder();
    const wrong = stubClient("1.00");
    const res = await send(db, approved("EV-5", c.paypal_order_id), wrong.client);
    expect(String(res.body.outcome)).toContain("amount_mismatch");
    expect(loadOrder(db, c.order_id)?.status).toBe("FAILED");
  });
});

describe("double delivery and races", () => {
  it("the same APPROVED event delivered twice captures once", async () => {
    const { db, c, total, stock, stockBefore } = await newOrder();
    const { client, calls } = stubClient(total);
    const ev = approved("EV-DUP", c.paypal_order_id);
    const [first, second] = [await send(db, ev, client), await send(db, ev, client)];
    expect(first.body).toMatchObject({ outcome: "captured" });
    expect(second.body).toMatchObject({ duplicate: true });
    expect(calls.capture).toBe(1);
    expect(stockBefore - stock()).toBe(2);
    expect(captures(db)).toBe(1);
  });

  it("two APPROVED events with different ids, after the return handler already captured, do not capture again", async () => {
    const { db, c, total } = await newOrder();
    const { client, calls } = stubClient(total);
    await captureCheckout(db, c.order_id, { env, client });
    const a = await send(db, approved("EV-A", c.paypal_order_id), client);
    const b = await send(db, approved("EV-B", c.paypal_order_id), client);
    expect(a.body).toMatchObject({ outcome: "already_settled" });
    expect(b.body).toMatchObject({ outcome: "already_settled" });
    expect(calls.capture).toBe(1);
    expect(captures(db)).toBe(1);
  });

  it("the return handler and two webhook deliveries at the same moment produce one capture and one stock change", async () => {
    const { db, c, total, stock, stockBefore } = await newOrder();
    const { client, calls } = stubClient(total);
    const results = await Promise.all([
      captureCheckout(db, c.order_id, { env, client }),
      send(db, approved("EV-R1", c.paypal_order_id), client),
      send(db, approved("EV-R2", c.paypal_order_id), client),
      captureCheckout(db, c.order_id, { env, client }),
    ]);
    expect(calls.capture).toBe(1);
    expect(stockBefore - stock()).toBe(2);
    expect(captures(db)).toBe(1);
    expect(loadOrder(db, c.order_id)?.status).toBe("PAID");
    expect((results[0] as { status: string }).status).toBe("PAID");
    for (const r of [results[1], results[2]] as { status: number }[]) expect(r.status).toBe(200);
  });

  it("simulation mode: an APPROVED webhook completes the order with no PayPal client at all", async () => {
    const { db, shop, c } = await newOrder();
    const res = await send(db, approved("EV-SIM", c.paypal_order_id));
    expect(res.body).toMatchObject({ outcome: "captured" });
    expect(getOrderStatus(db, shop, c.order_id).status).toBe("PAID");
  });
});
