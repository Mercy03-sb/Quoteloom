import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveAndSubmit, DisputeError, getEvidence, handleDisputeEvent, listDisputes, loadDispute, openDispute, simulateDispute } from "@/lib/disputes";
import { buildEvidencePacket, captureIdFor, evidenceNotes, provideEvidenceBody } from "@/lib/evidence";
import { captureCheckout, createCheckout } from "@/lib/orders";
import { listOrders, visibleOrder, visibleShopIds } from "@/lib/orders-view";
import { submitDisputeEvidence } from "@/lib/paypal";
import { issueQuote } from "@/lib/quote";
import { SIM_SIGNATURE_HEADER, simWebhookSignature } from "@/lib/paypal";
import { handlePaypalWebhook, simWebhookSecret } from "@/lib/webhook";
import { seededDb } from "./helpers";

beforeEach(() => {
  vi.stubEnv("QUOTE_SIGNING_SECRET", "dispute-secret");
  vi.stubEnv("PAYPAL_CLIENT_ID", "");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

async function paidOrder(offerCents?: number) {
  const { db, shop } = seededDb();
  const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 2, offerCents, agentId: "test-agent" });
  const c = await createCheckout(db, shop, q.id, "http://localhost:3000");
  await captureCheckout(db, c.order_id);
  return { db, shop, q, orderId: c.order_id, paypalOrderId: c.paypal_order_id };
}

describe("evidence packet", () => {
  it("contains the request, negotiation, signed quote with validity, order and capture, and timestamps", async () => {
    const { db, orderId, q } = await paidOrder(4300);
    const d = simulateDispute(db, orderId);
    const p = getEvidence(loadDispute(db, d.id)!)!;
    expect(p.simulated).toBe(true);
    expect(p.dispute).toMatchObject({ order_id: orderId, reason: "UNAUTHORISED", simulated: true });
    expect(p.buyer_request).toMatchObject({ sku: "LT-SCARF-WOOL-GRY", qty: 2, offer_price_cents: 4300, agent: "test-agent" });
    expect(p.negotiation.outcome).toBe("accepted");
    expect(p.negotiation.offers).toHaveLength(1);
    expect(p.negotiation.reasons.length).toBeGreaterThan(0);
    expect(p.negotiation.transcript.map((e) => e.type)).toEqual(["request", "decision", "message"]);
    expect(p.negotiation.message).toBeTruthy();
    expect(p.quote).toMatchObject({ id: q.id, unit_price_cents: 4300, list_price_cents: 4800, total_cents: 8600, signature: q.signature, signature_intact: true, valid_when_ordered: true });
    expect(p.order).toMatchObject({ id: orderId, status: "PAID", amount_cents: 8600 });
    expect(p.order.capture_id).toBe(captureIdFor(db, orderId));
    expect(p.order.capture_id).toMatch(/^SIMCAP-/);
    expect(p.order.captured_at).toBeTruthy();
    expect(p.checks.every((c) => c.ok)).toBe(true);
    const types = p.timeline.map((t) => t.type);
    expect(types).toContain("quote.requested");
    expect(types).toContain("order.created");
    expect(types[types.length - 1]).toBe("dispute.opened");
    expect(p.timeline.map((t) => t.ts)).toEqual([...p.timeline.map((t) => t.ts)].sort());
  });

  it("flags a tampered quote and an order made after expiry", async () => {
    const { db, orderId, q } = await paidOrder();
    const d = simulateDispute(db, orderId);
    db.prepare("UPDATE quotes SET price_cents = 1 WHERE id = ?").run(q.id);
    const tampered = buildEvidencePacket(db, { id: d.id, order_id: orderId, paypal_dispute_id: d.paypal_dispute_id, reason: d.reason, amount_cents: d.amount_cents, currency: "USD", opened_at: new Date().toISOString(), simulated: true });
    expect(tampered.quote.signature_intact).toBe(false);
    expect(tampered.checks.find((c) => c.label.includes("signature"))?.ok).toBe(false);
    expect(tampered.checks.find((c) => c.label.includes("matches the quote"))?.ok).toBe(false);

    const t2 = await paidOrder();
    const d2 = simulateDispute(t2.db, t2.orderId);
    t2.db.prepare("UPDATE quotes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(t2.q.id);
    // moving expiry also breaks the signature, so both flags go false: the packet never claims validity it cannot prove
    const late = buildEvidencePacket(t2.db, { id: d2.id, order_id: t2.orderId, paypal_dispute_id: null, reason: "", amount_cents: 0, currency: "USD", opened_at: new Date().toISOString(), simulated: true });
    expect(late.quote.valid_when_ordered).toBe(false);
  });

  it("builds the PayPal request body with the key facts, within the 2000 character limit", async () => {
    const { db, orderId } = await paidOrder(4300);
    const p = getEvidence(simulateDispute(db, orderId))!;
    const body = provideEvidenceBody(p);
    expect(body.evidences).toHaveLength(1);
    const notes = body.evidences[0].notes;
    expect(notes).toContain("SIMULATED DISPUTE");
    expect(notes).toContain(p.quote.id);
    expect(notes).toContain("43.00");
    expect(notes).toContain("Signature intact: yes");
    expect(notes.length).toBeLessThanOrEqual(2000);
    expect(evidenceNotes({ ...p, simulated: false })).not.toContain("SIMULATED");
  });
});

describe("simulate and submit", () => {
  it("refuses a dispute on an unpaid order or an unknown order", async () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 });
    const c = await createCheckout(db, shop, q.id, "http://localhost:3000");
    expect(() => simulateDispute(db, c.order_id)).toThrowError(expect.objectContaining({ code: "not_paid" }));
    expect(() => simulateDispute(db, "nope")).toThrowError(expect.objectContaining({ code: "unknown_order" }));
  });

  it("submits a simulated dispute without touching the network, once", async () => {
    const { db, orderId } = await paidOrder();
    const d = simulateDispute(db, orderId);
    expect(d.paypal_dispute_id).toMatch(/^SIM-DSP-/);
    const fetchImpl = vi.fn();
    const out = await approveAndSubmit(db, d.id, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.dispute.status).toBe("SUBMITTED");
    expect(out.dispute.submitted_at).toBeTruthy();
    const sub = JSON.parse(out.dispute.submission_json!) as { simulated: boolean; request: { path: string } };
    expect(sub.simulated).toBe(true);
    expect(sub.request.path).toBe(`/v1/customer/disputes/${d.paypal_dispute_id}/provide-evidence`);
    await expect(approveAndSubmit(db, d.id)).rejects.toMatchObject({ code: "already_submitted" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'dispute.submitted'").get()).toEqual({ n: 1 });
  });

  it("sends the packet to the Disputes API for a real (not simulated) dispute in sandbox mode, and keeps it OPEN on failure", async () => {
    const { db, orderId } = await paidOrder();
    const d = openDispute(db, { orderId, paypalDisputeId: "PP-D-1", reason: "UNAUTHORISED", simulated: false });
    const env = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
    const calls: { url: string; body?: string }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      return url.includes("oauth2") ? Response.json({ access_token: "tok" }) : Response.json({}, { status: 200 });
    }) as unknown as typeof fetch;
    const bad = (async (url: string) => (String(url).includes("oauth2") ? Response.json({ access_token: "tok" }) : Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 }))) as unknown as typeof fetch;

    await expect(approveAndSubmit(db, d.id, { env, fetchImpl: bad })).rejects.toMatchObject({ code: "submit_failed", message: expect.stringContaining("404") });
    expect(loadDispute(db, d.id)!.status).toBe("OPEN");

    const done = await approveAndSubmit(db, d.id, { env, fetchImpl: ok });
    expect(done.dispute.status).toBe("SUBMITTED");
    const post = calls.find((c) => c.url.includes("provide-evidence"))!;
    expect(post.url).toBe("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence");
    expect(JSON.parse(post.body!).evidences[0].evidence_type).toBe("OTHER");
    expect(JSON.parse(done.dispute.submission_json!).simulated).toBe(false);
  });

  it("submitDisputeEvidence in sim mode never calls fetch", async () => {
    const f = vi.fn();
    const r = await submitDisputeEvidence("X", { evidences: [] }, { env: {}, fetchImpl: f as unknown as typeof fetch });
    expect(r.mode).toBe("sim");
    expect(f).not.toHaveBeenCalled();
  });

  it("raises DisputeError for an unknown dispute", async () => {
    const { db } = seededDb();
    await expect(approveAndSubmit(db, "nope")).rejects.toBeInstanceOf(DisputeError);
  });
});

describe("dispute webhooks", () => {
  const env = {};
  const send = (db: Parameters<typeof handlePaypalWebhook>[0], body: object, sign = true) => {
    const raw = JSON.stringify(body);
    const headers = new Headers(sign ? { [SIM_SIGNATURE_HEADER]: simWebhookSignature(raw, simWebhookSecret(env)) } : {});
    return handlePaypalWebhook(db, raw, headers, { env });
  };
  const created = (id: string, capture: string | null, disputeId = "PP-D-77") => ({
    id,
    event_type: "CUSTOMER.DISPUTE.CREATED",
    resource: {
      dispute_id: disputeId,
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_amount: { value: "86.00", currency_code: "USD" },
      disputed_transactions: capture ? [{ seller_transaction_id: capture }] : [],
    },
  });

  it("rejects an unsigned dispute event and stores nothing", async () => {
    const { db, orderId } = await paidOrder();
    const res = await send(db, created("D-1", captureIdFor(db, orderId)), false);
    expect(res.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM disputes").get()).toEqual({ n: 0 });
  });

  it("stores a verified dispute with its packet, matched to the order by capture id, and dedupes by event id", async () => {
    const { db, orderId } = await paidOrder(4300);
    const ev = created("D-2", captureIdFor(db, orderId));
    const first = await send(db, ev);
    expect(first).toMatchObject({ status: 200, body: { outcome: "dispute_stored" } });
    const rows = listDisputes(db, visibleShopIds(db, null));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ order_id: orderId, paypal_dispute_id: "PP-D-77", status: "OPEN", simulated: 0, amount_cents: 8600 });
    const packet = getEvidence(loadDispute(db, rows[0].id)!)!;
    expect(packet.simulated).toBe(false);
    expect(packet.quote.unit_price_cents).toBe(4300);

    const again = await send(db, ev);
    expect(again.body).toMatchObject({ duplicate: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM disputes").get()).toEqual({ n: 1 });
  });

  it("a second event for the same dispute updates it instead of duplicating, and never moves SUBMITTED back", async () => {
    const { db, orderId } = await paidOrder();
    await send(db, created("D-3", captureIdFor(db, orderId)));
    const id = (db.prepare("SELECT id FROM disputes").get() as { id: string }).id;
    await approveAndSubmit(db, id, { env: {} });
    const upd = { ...created("D-4", captureIdFor(db, orderId)), event_type: "CUSTOMER.DISPUTE.UPDATED" };
    expect((await send(db, upd)).body).toMatchObject({ outcome: "dispute_updated" });
    expect(loadDispute(db, id)!.status).toBe("SUBMITTED");
    const resolved = { ...created("D-5", captureIdFor(db, orderId)), event_type: "CUSTOMER.DISPUTE.RESOLVED" };
    await send(db, resolved);
    expect(loadDispute(db, id)!.status).toBe("RESOLVED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM disputes").get()).toEqual({ n: 1 });
  });

  it("ignores a dispute for a transaction that is not ours", async () => {
    const { db } = await paidOrder();
    expect((await send(db, created("D-6", "UNKNOWN-CAP"))).body).toMatchObject({ outcome: "unknown_order" });
    expect(handleDisputeEvent(db, "CUSTOMER.DISPUTE.CREATED", {}).outcome).toBe("missing_dispute_id");
    expect(db.prepare("SELECT COUNT(*) AS n FROM disputes").get()).toEqual({ n: 0 });
  });
});

describe("orders view", () => {
  it("lists orders with negotiation info and respects workspace visibility", async () => {
    const { db, orderId } = await paidOrder(4300);
    const rows = listOrders(db, visibleShopIds(db, null));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: orderId, negotiated: true, list_price_cents: 4800, unit_price_cents: 4300, qty: 2, status: "PAID", disputes: 0 });
    expect(visibleOrder(db, null, orderId)?.id).toBe(orderId);
    expect(listOrders(db, [])).toEqual([]);
    expect(visibleOrder(db, null, "nope")).toBeUndefined();
  });
});
