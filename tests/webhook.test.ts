import { describe, expect, it } from "vitest";
import { createCheckout, loadOrder } from "@/lib/orders";
import { SIM_SIGNATURE_HEADER, simWebhookSignature, valueToCents } from "@/lib/paypal";
import { issueQuote } from "@/lib/quote";
import { handlePaypalWebhook, simulateCaptureWebhook, simWebhookSecret } from "@/lib/webhook";
import { seededDb } from "./helpers";

const env = { QUOTE_SIGNING_SECRET: "wh-secret" };

async function order() {
  const { db, shop } = seededDb();
  const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 }, { secret: "wh-secret" });
  const c = await createCheckout(db, shop, q.id, "http://localhost:3000", { secret: "wh-secret", env });
  return { db, c };
}
const signed = (body: object) => {
  const raw = JSON.stringify(body);
  return { raw, headers: new Headers({ [SIM_SIGNATURE_HEADER]: simWebhookSignature(raw, simWebhookSecret(env)) }) };
};
const capture = (id: string, orderId: string, value = "48.00") => ({
  id,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP", amount: { value, currency_code: "USD" }, supplementary_data: { related_ids: { order_id: orderId } } },
});

describe("webhook receiver (simulation mode)", () => {
  it("rejects a missing or wrong signature and changes nothing", async () => {
    const { db, c } = await order();
    const raw = JSON.stringify(capture("E1", c.paypal_order_id));
    expect((await handlePaypalWebhook(db, raw, new Headers(), { env })).status).toBe(401);
    const bad = new Headers({ [SIM_SIGNATURE_HEADER]: simWebhookSignature(raw, "wrong") });
    expect((await handlePaypalWebhook(db, raw, bad, { env })).status).toBe(401);
    expect(loadOrder(db, c.order_id)?.status).toBe("CREATED");
  });
  it("rejects a body altered after signing", async () => {
    const { db, c } = await order();
    const { raw, headers } = signed(capture("E1", c.paypal_order_id));
    expect((await handlePaypalWebhook(db, raw.replace("48.00", "1.00"), headers, { env })).status).toBe(401);
  });
  it("marks the order PAID on a valid capture event", async () => {
    const { db, c } = await order();
    const { raw, headers } = signed(capture("E1", c.paypal_order_id));
    const res = await handlePaypalWebhook(db, raw, headers, { env });
    expect(res).toMatchObject({ status: 200, body: { outcome: "status_PAID" } });
    expect(loadOrder(db, c.order_id)?.status).toBe("PAID");
  });
  it("ignores duplicate deliveries of the same event id", async () => {
    const { db, c } = await order();
    const { raw, headers } = signed(capture("E1", c.paypal_order_id));
    await handlePaypalWebhook(db, raw, headers, { env });
    const again = await handlePaypalWebhook(db, raw, headers, { env });
    expect(again.body).toMatchObject({ duplicate: true });
  });
  it("does not regress a PAID order when APPROVED arrives late", async () => {
    const { db, c } = await order();
    const a = signed(capture("E1", c.paypal_order_id));
    await handlePaypalWebhook(db, a.raw, a.headers, { env });
    const late = signed({ id: "E2", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: c.paypal_order_id } });
    expect((await handlePaypalWebhook(db, late.raw, late.headers, { env })).body).toMatchObject({ outcome: "no_change" });
    expect(loadOrder(db, c.order_id)?.status).toBe("PAID");
  });
  it("applies APPROVED, and REFUNDED after PAID", async () => {
    const { db, c } = await order();
    const ap = signed({ id: "E1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: c.paypal_order_id } });
    await handlePaypalWebhook(db, ap.raw, ap.headers, { env });
    expect(loadOrder(db, c.order_id)?.status).toBe("APPROVED");
    const paid = signed(capture("E2", c.paypal_order_id));
    await handlePaypalWebhook(db, paid.raw, paid.headers, { env });
    const ref = signed({ ...capture("E3", c.paypal_order_id), event_type: "PAYMENT.CAPTURE.REFUNDED" });
    await handlePaypalWebhook(db, ref.raw, ref.headers, { env });
    expect(loadOrder(db, c.order_id)?.status).toBe("REFUNDED");
  });
  it("ignores a capture whose amount differs from the order", async () => {
    const { db, c } = await order();
    const { raw, headers } = signed(capture("E1", c.paypal_order_id, "1.00"));
    expect((await handlePaypalWebhook(db, raw, headers, { env })).body).toMatchObject({ outcome: "amount_mismatch_ignored" });
    expect(loadOrder(db, c.order_id)?.status).toBe("CREATED");
  });
  it("acknowledges unknown orders and unrelated event types without changes", async () => {
    const { db, c } = await order();
    const u = signed(capture("E1", "NOPE"));
    expect((await handlePaypalWebhook(db, u.raw, u.headers, { env })).body).toMatchObject({ outcome: "unknown_order" });
    const o = signed({ id: "E2", event_type: "BILLING.PLAN.CREATED", resource: {} });
    expect((await handlePaypalWebhook(db, o.raw, o.headers, { env })).body).toMatchObject({ outcome: "ignored_event_type" });
    expect(loadOrder(db, c.order_id)?.status).toBe("CREATED");
  });
  it("rejects malformed JSON and events without an id", async () => {
    const { db } = await order();
    const bad = signed({ nope: true });
    expect((await handlePaypalWebhook(db, bad.raw, bad.headers, { env })).status).toBe(400);
    const raw = "{not json";
    const headers = new Headers({ [SIM_SIGNATURE_HEADER]: simWebhookSignature(raw, simWebhookSecret(env)) });
    expect((await handlePaypalWebhook(db, raw, headers, { env })).status).toBe(400);
  });
  it("simulateCaptureWebhook delivers a verified event", async () => {
    const { db, c } = await order();
    const res = await simulateCaptureWebhook(db, c.order_id, env);
    expect(res?.status).toBe(200);
    expect(loadOrder(db, c.order_id)?.status).toBe("PAID");
  });
});

describe("webhook receiver (sandbox verification)", () => {
  const sandboxEnv = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH1" };
  const headers = () =>
    new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
      "paypal-transmission-id": "t1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-11-01T00:00:00Z",
    });
  const fakeFetch = (status: string): typeof fetch =>
    (async (url: string) =>
      String(url).includes("oauth2/token")
        ? Response.json({ access_token: "tok" })
        : Response.json({ verification_status: status })) as unknown as typeof fetch;

  it("accepts when PayPal verifies the signature", async () => {
    const { db, c } = await order();
    const raw = JSON.stringify(capture("E1", c.paypal_order_id));
    const res = await handlePaypalWebhook(db, raw, headers(), { env: sandboxEnv, fetchImpl: fakeFetch("SUCCESS") });
    expect(res.status).toBe(200);
  });
  it("rejects when PayPal says the signature fails", async () => {
    const { db, c } = await order();
    const raw = JSON.stringify(capture("E1", c.paypal_order_id));
    const res = await handlePaypalWebhook(db, raw, headers(), { env: sandboxEnv, fetchImpl: fakeFetch("FAILURE") });
    expect(res.status).toBe(401);
  });
  it("rejects when PAYPAL_WEBHOOK_ID is not configured or headers are missing", async () => {
    const { db, c } = await order();
    const raw = JSON.stringify(capture("E1", c.paypal_order_id));
    const noId = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s" };
    expect((await handlePaypalWebhook(db, raw, headers(), { env: noId, fetchImpl: fakeFetch("SUCCESS") })).status).toBe(401);
    expect((await handlePaypalWebhook(db, raw, new Headers(), { env: sandboxEnv, fetchImpl: fakeFetch("SUCCESS") })).status).toBe(401);
  });
});

describe("valueToCents", () => {
  it("parses decimal amounts strictly", () => {
    expect(valueToCents("48.00")).toBe(4800);
    expect(valueToCents("0.5")).toBe(50);
    expect(valueToCents("12")).toBe(1200);
    expect(valueToCents("abc")).toBeNull();
    expect(valueToCents("-1.00")).toBeNull();
    expect(valueToCents(undefined)).toBeNull();
  });
});
