// Evidence packet for a dispute, assembled only from data we stored: the buyer's request, the negotiation
// transcript, the signed quote and whether it was valid when the order was made, and the order and capture.
import type { DB } from "./db";
import { loadOrder, orderEvents } from "./orders";
import { signingSecret, verifyQuote, type QuoteFields } from "./quote";

export type PacketDispute = {
  id: string;
  order_id: string;
  paypal_dispute_id: string | null;
  reason: string;
  amount_cents: number;
  currency: string;
  opened_at: string;
  simulated: boolean;
};

export type EvidencePacket = {
  version: 1;
  generated_at: string;
  simulated: boolean;
  dispute: PacketDispute;
  buyer_request: { ts: string; agent: string | null; sku: string; qty: number; offer_price_cents: number | null } | null;
  negotiation: {
    transcript: Record<string, unknown>[];
    offers: { ts: string; offer_cents: number | null; unit_price_cents: number }[];
    outcome: string | null;
    reasons: string[];
    message: string | null;
  };
  quote: {
    id: string;
    sku: string;
    title: string;
    qty: number;
    unit_price_cents: number;
    list_price_cents: number | null;
    total_cents: number;
    currency: string;
    issued_at: string | null;
    expires_at: string;
    signature: string;
    signature_intact: boolean;
    valid_when_ordered: boolean;
  };
  order: {
    id: string;
    paypal_order_id: string;
    status: string;
    amount_cents: number;
    currency: string;
    created_at: string;
    captured_at: string | null;
    capture_id: string | null;
  };
  timeline: { ts: string; type: string; detail: string }[];
  checks: { label: string; ok: boolean; detail: string }[];
};

/** SQLite's datetime('now') is UTC without a zone marker. */
export function sqliteToIso(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

const money = (c: number, cur: string) => `${(c / 100).toFixed(2)} ${cur}`;

export class EvidenceError extends Error {}

export function captureIdFor(db: DB, orderId: string): string | null {
  const row = db
    .prepare("SELECT json_extract(payload_json, '$.capture_id') AS c FROM events WHERE type = 'order.captured' AND json_extract(payload_json, '$.order_id') = ? ORDER BY id DESC LIMIT 1")
    .get(orderId) as { c: string | null } | undefined;
  return row?.c ?? null;
}

/** Assemble the packet from stored data. Throws EvidenceError if the order or its quote is gone. */
export function buildEvidencePacket(db: DB, dispute: PacketDispute, now = new Date(), secret = signingSecret()): EvidencePacket {
  const order = loadOrder(db, dispute.order_id);
  if (!order) throw new EvidenceError("The order for this dispute no longer exists.");
  const q = db
    .prepare("SELECT transcript_json FROM quotes WHERE id = ?")
    .get(order.quote_id) as { transcript_json: string } | undefined;
  if (!q) throw new EvidenceError("The signed quote for this order no longer exists.");
  let transcript: Record<string, unknown>[] = [];
  try {
    transcript = JSON.parse(q.transcript_json) as Record<string, unknown>[];
  } catch {
    /* leave empty: the missing transcript shows up as a failed check */
  }
  const req = transcript.find((e) => e.type === "request");
  const decision = transcript.find((e) => e.type === "decision");
  const msg = transcript.find((e) => e.type === "message");
  const history = transcript.find((e) => e.type === "offer_history") as { prior?: { ts: string; offer_cents: number | null; unit_price_cents: number }[] } | undefined;

  const fields: QuoteFields = {
    id: order.quote_id,
    shop: order.shop_slug,
    sku: order.sku,
    qty: order.qty,
    price_cents: order.unit_price_cents,
    currency: order.currency,
    expires_at: order.quote_expires_at,
  };
  const intact = verifyQuote(fields, order.quote_signature, secret, new Date(0)).ok; // epoch: never "expired", so only the HMAC is tested
  const orderedAt = new Date(sqliteToIso(order.created_at) ?? now.toISOString());
  const validWhenOrdered = verifyQuote(fields, order.quote_signature, secret, orderedAt).ok;

  const offers = [
    ...(history?.prior ?? []),
    ...(req && req.offer_cents != null
      ? [{ ts: String(req.ts), offer_cents: Number(req.offer_cents), unit_price_cents: Number(decision?.unit_price_cents ?? order.unit_price_cents) }]
      : []),
  ];
  const capture = captureIdFor(db, order.id);
  const timeline = [
    ...(req ? [{ ts: String(req.ts), type: "quote.requested", detail: `Buyer agent asked for ${req.qty} x ${req.sku}${req.offer_cents != null ? `, offering ${money(Number(req.offer_cents), order.currency)} each` : ""}` }] : []),
    ...orderEvents(db, order.id).map((e) => ({ ts: sqliteToIso(e.ts) ?? e.ts, type: e.type, detail: e.detail })),
    { ts: dispute.opened_at, type: "dispute.opened", detail: `Dispute opened: ${dispute.reason || "no reason given"}` },
  ]
    .map((e) => ({ ...e, ts: `${e.ts.slice(0, 19)}Z` })) // order events are stored with 1 s resolution; match it so ties keep their causal order
    .sort((a, b) => a.ts.localeCompare(b.ts)); // stable sort

  const checks = [
    { label: "Buyer request is on record", ok: Boolean(req), detail: req ? `Request logged at ${req.ts}` : "No request entry in the transcript" },
    { label: "Quote signature is intact", ok: intact, detail: intact ? "HMAC-SHA256 matches the stored terms" : "The stored terms do not match the signature" },
    { label: "Quote was valid when the order was made", ok: validWhenOrdered, detail: validWhenOrdered ? `Ordered ${order.created_at} UTC, before expiry ${order.quote_expires_at}` : "The order was made after expiry, or the signature failed" },
    { label: "Order matches the quote", ok: order.amount_cents === order.unit_price_cents * order.qty, detail: `${money(order.amount_cents, order.currency)} charged for ${order.qty} x ${money(order.unit_price_cents, order.currency)}` },
    { label: "Payment was captured", ok: order.status === "PAID" || order.status === "REFUNDED", detail: order.captured_at ? `Captured ${order.captured_at} UTC${capture ? `, capture ${capture}` : ""}` : `Order status ${order.status}` },
  ];

  return {
    version: 1,
    generated_at: now.toISOString(),
    simulated: dispute.simulated,
    dispute,
    buyer_request: req
      ? { ts: String(req.ts), agent: (req.agent as string | null) ?? null, sku: String(req.sku), qty: Number(req.qty), offer_price_cents: req.offer_cents == null ? null : Number(req.offer_cents) }
      : null,
    negotiation: {
      transcript,
      offers,
      outcome: decision ? String(decision.outcome ?? "") || null : null,
      reasons: Array.isArray(decision?.reasons) ? (decision.reasons as string[]) : [],
      message: msg ? String(msg.text) : null,
    },
    quote: {
      id: order.quote_id,
      sku: order.sku,
      title: order.title,
      qty: order.qty,
      unit_price_cents: order.unit_price_cents,
      list_price_cents: decision?.list_price_cents == null ? null : Number(decision.list_price_cents),
      total_cents: order.unit_price_cents * order.qty,
      currency: order.currency,
      issued_at: req ? String(req.ts) : null,
      expires_at: order.quote_expires_at,
      signature: order.quote_signature,
      signature_intact: intact,
      valid_when_ordered: validWhenOrdered,
    },
    order: {
      id: order.id,
      paypal_order_id: order.paypal_order_id,
      status: order.status,
      amount_cents: order.amount_cents,
      currency: order.currency,
      created_at: order.created_at,
      captured_at: order.captured_at,
      capture_id: capture,
    },
    timeline,
    checks,
  };
}

/** Plain-text summary for PayPal's `notes` field (limit 2000 characters). */
export function evidenceNotes(p: EvidencePacket): string {
  const q = p.quote;
  const lines = [
    `Merchant evidence for order ${p.order.id} (PayPal order ${p.order.paypal_order_id}).`,
    p.buyer_request
      ? `Buyer agent requested ${p.buyer_request.qty} x ${p.buyer_request.sku} at ${p.buyer_request.ts}${p.buyer_request.offer_price_cents != null ? `, offering ${money(p.buyer_request.offer_price_cents, q.currency)} each` : ""}.`
      : "No buyer request on record.",
    `Negotiation: ${p.negotiation.offers.length} offer(s), outcome ${p.negotiation.outcome ?? "n/a"}. Final price ${money(q.unit_price_cents, q.currency)} each${q.list_price_cents ? ` (list ${money(q.list_price_cents, q.currency)})` : ""}, total ${money(q.total_cents, q.currency)}.`,
    `Signed quote ${q.id}, expires ${q.expires_at}. Signature intact: ${q.signature_intact ? "yes" : "NO"}. Valid when ordered: ${q.valid_when_ordered ? "yes" : "NO"}. Signature ${q.signature}.`,
    `Order created ${p.order.created_at} UTC, status ${p.order.status}${p.order.captured_at ? `, captured ${p.order.captured_at} UTC` : ""}${p.order.capture_id ? ` (capture ${p.order.capture_id})` : ""}, charged ${money(p.order.amount_cents, p.order.currency)}.`,
  ];
  if (p.simulated) lines.unshift("SIMULATED DISPUTE (demo): not a real PayPal dispute.");
  return lines.join("\n").slice(0, 2000);
}

/** Body for POST /v1/customer/disputes/{id}/provide-evidence. */
export function provideEvidenceBody(p: EvidencePacket): { evidences: { evidence_type: string; notes: string }[] } {
  return { evidences: [{ evidence_type: "OTHER", notes: evidenceNotes(p) }] };
}
