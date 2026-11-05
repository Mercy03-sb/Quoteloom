// Disputes: stored from PayPal webhooks (or the demo "Simulate dispute" action), evidence assembled from
// stored data, submitted through the Disputes API after the merchant approves. Simulated disputes use the
// same code path, but the final HTTP call is skipped and everything is labelled as simulated.
import { randomBytes } from "node:crypto";
import type { DB } from "./db";
import { DISPUTE_LABELS } from "./dispute-labels";
import { buildEvidencePacket, EvidenceError, provideEvidenceBody, sqliteToIso, type EvidencePacket, type PacketDispute } from "./evidence";
import { findOrderByPaypalId, loadOrder, logEvent } from "./orders";
import { submitDisputeEvidence, type EvidenceSubmission } from "./paypal";

export type DisputeStatus = "OPEN" | "SUBMITTED" | "RESOLVED";

export const DISPUTE_REASONS = DISPUTE_LABELS;

export class DisputeError extends Error {
  constructor(
    readonly code: "unknown_dispute" | "unknown_order" | "not_paid" | "already_submitted" | "no_evidence" | "submit_failed",
    message: string,
  ) {
    super(message);
    this.name = "DisputeError";
  }
}

export type DisputeRow = {
  id: string;
  order_id: string;
  paypal_dispute_id: string | null;
  status: DisputeStatus;
  reason: string;
  amount_cents: number;
  currency: string;
  simulated: number;
  paypal_status: string | null;
  created_at: string;
  submitted_at: string | null;
  submission_json: string | null;
  evidence_json: string;
};

const COLS = "id, order_id, paypal_dispute_id, status, reason, amount_cents, currency, simulated, paypal_status, created_at, submitted_at, submission_json, evidence_json";

export function loadDispute(db: DB, id: string): DisputeRow | undefined {
  return db.prepare(`SELECT ${COLS} FROM disputes WHERE id = ? AND is_demo = 0`).get(id) as DisputeRow | undefined;
}

function toPacketDispute(d: DisputeRow): PacketDispute {
  return {
    id: d.id,
    order_id: d.order_id,
    paypal_dispute_id: d.paypal_dispute_id,
    reason: d.reason,
    amount_cents: d.amount_cents,
    currency: d.currency,
    opened_at: sqliteToIso(d.created_at) ?? d.created_at,
    simulated: d.simulated === 1,
  };
}

export type OpenDisputeInput = {
  orderId: string;
  paypalDisputeId?: string | null;
  reason: string;
  amountCents?: number;
  simulated: boolean;
  paypalStatus?: string | null;
};

/** Create the dispute row and its evidence packet. Shared by the webhook handler and the simulator. */
export function openDispute(db: DB, input: OpenDisputeInput, now = new Date()): DisputeRow {
  const order = loadOrder(db, input.orderId);
  if (!order) throw new DisputeError("unknown_order", "No such order.");
  const id = `dsp_${randomBytes(10).toString("hex")}`;
  const row: DisputeRow = {
    id,
    order_id: order.id,
    paypal_dispute_id: input.paypalDisputeId ?? null,
    status: "OPEN",
    reason: input.reason,
    amount_cents: input.amountCents ?? order.amount_cents,
    currency: order.currency,
    simulated: input.simulated ? 1 : 0,
    paypal_status: input.paypalStatus ?? null,
    created_at: now.toISOString().slice(0, 19).replace("T", " "),
    submitted_at: null,
    submission_json: null,
    evidence_json: "{}",
  };
  const packet = buildEvidencePacket(db, toPacketDispute(row), now);
  db.prepare(
    `INSERT INTO disputes (id, order_id, paypal_dispute_id, status, evidence_json, reason, amount_cents, currency, simulated, paypal_status, created_at)
     VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, row.order_id, row.paypal_dispute_id, JSON.stringify(packet), row.reason, row.amount_cents, row.currency, row.simulated, row.paypal_status, row.created_at);
  logEvent(db, "dispute.opened", { dispute_id: id, order_id: order.id, simulated: input.simulated });
  return { ...row, evidence_json: JSON.stringify(packet) };
}

/** Demo action: a clearly labelled, simulated dispute on a paid order. */
export function simulateDispute(db: DB, orderId: string, reason = "UNAUTHORISED", now = new Date()): DisputeRow {
  const order = loadOrder(db, orderId);
  if (!order) throw new DisputeError("unknown_order", "No such order.");
  if (order.status !== "PAID") throw new DisputeError("not_paid", "Only a paid order can be disputed.");
  const r = reason in DISPUTE_REASONS ? reason : "UNAUTHORISED";
  return openDispute(db, { orderId, paypalDisputeId: `SIM-DSP-${randomBytes(5).toString("hex").toUpperCase()}`, reason: r, simulated: true, paypalStatus: "WAITING_FOR_SELLER_RESPONSE" }, now);
}

export function getEvidence(d: DisputeRow): EvidencePacket | null {
  try {
    const p = JSON.parse(d.evidence_json) as EvidencePacket;
    return p && p.version === 1 ? p : null;
  } catch {
    return null;
  }
}

export type Submitted = { dispute: DisputeRow; submission: EvidenceSubmission };

type SubmitOpts = { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: Date };

/**
 * The merchant approved: rebuild the packet from stored data, send it, mark SUBMITTED.
 * A failed submission leaves the dispute OPEN with the error logged, so it can be retried.
 */
export async function approveAndSubmit(db: DB, disputeId: string, opts: SubmitOpts = {}): Promise<Submitted> {
  const d = loadDispute(db, disputeId);
  if (!d) throw new DisputeError("unknown_dispute", "No such dispute.");
  if (d.status !== "OPEN") throw new DisputeError("already_submitted", `This dispute is ${d.status}; evidence was already sent.`);
  const now = opts.now ?? new Date();
  let packet: EvidencePacket;
  try {
    packet = buildEvidencePacket(db, toPacketDispute(d), now);
  } catch (e) {
    if (e instanceof EvidenceError) throw new DisputeError("no_evidence", e.message);
    throw e;
  }
  const ref = d.paypal_dispute_id ?? d.id;
  let submission: EvidenceSubmission;
  try {
    submission = await submitDisputeEvidence(ref, provideEvidenceBody(packet), { env: opts.env, fetchImpl: opts.fetchImpl, simulated: d.simulated === 1 });
  } catch (e) {
    logEvent(db, "dispute.submit_failed", { dispute_id: d.id, order_id: d.order_id, error: (e as Error).message });
    throw new DisputeError("submit_failed", (e as Error).message);
  }
  db.prepare("UPDATE disputes SET status = 'SUBMITTED', evidence_json = ?, submitted_at = datetime('now'), submission_json = ? WHERE id = ? AND status = 'OPEN'").run(
    JSON.stringify(packet),
    JSON.stringify({ mode: submission.mode, simulated: d.simulated === 1 || submission.mode === "sim", request: submission.request, response: submission.response }),
    d.id,
  );
  logEvent(db, "dispute.submitted", { dispute_id: d.id, order_id: d.order_id, mode: submission.mode, simulated: d.simulated === 1 });
  return { dispute: loadDispute(db, d.id)!, submission };
}

// ---------- webhook events ----------

type DisputeResource = {
  dispute_id?: string;
  reason?: string;
  status?: string;
  dispute_amount?: { value?: string; currency_code?: string };
  disputed_transactions?: { seller_transaction_id?: string; buyer_transaction_id?: string }[];
};

function orderForDispute(db: DB, res: DisputeResource) {
  for (const t of res.disputed_transactions ?? []) {
    const cap = t.seller_transaction_id;
    if (!cap) continue;
    const hit = db
      .prepare("SELECT json_extract(payload_json, '$.order_id') AS oid FROM events WHERE type = 'order.captured' AND json_extract(payload_json, '$.capture_id') = ? LIMIT 1")
      .get(cap) as { oid: string } | undefined;
    const order = hit?.oid ? loadOrder(db, hit.oid) : findOrderByPaypalId(db, cap);
    if (order) return order;
  }
  return undefined;
}

/**
 * CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED, already signature-verified and de-duplicated by the caller.
 * Returns the outcome string for the audit log.
 */
export function handleDisputeEvent(db: DB, eventType: string, res: DisputeResource): { outcome: string; orderId: string | null } {
  const pid = res.dispute_id;
  if (!pid) return { outcome: "missing_dispute_id", orderId: null };
  const existing = db.prepare(`SELECT ${COLS} FROM disputes WHERE paypal_dispute_id = ?`).get(pid) as DisputeRow | undefined;
  const resolved = eventType.endsWith(".RESOLVED") || ["RESOLVED", "CLOSED"].includes(String(res.status));
  if (existing) {
    // Forward only: a late UPDATED never moves SUBMITTED back to OPEN.
    const next: DisputeStatus = resolved ? "RESOLVED" : existing.status;
    db.prepare("UPDATE disputes SET status = ?, paypal_status = COALESCE(?, paypal_status) WHERE id = ?").run(next, res.status ?? null, existing.id);
    return { outcome: next === existing.status ? "dispute_updated" : `dispute_${next}`, orderId: existing.order_id };
  }
  const order = orderForDispute(db, res);
  if (!order) return { outcome: "unknown_order", orderId: null };
  const cents = res.dispute_amount?.value ? Math.round(Number(res.dispute_amount.value) * 100) : undefined;
  const d = openDispute(db, {
    orderId: order.id,
    paypalDisputeId: pid,
    reason: res.reason ?? "",
    amountCents: Number.isFinite(cents) ? cents : undefined,
    simulated: false,
    paypalStatus: res.status ?? null,
  });
  if (resolved) db.prepare("UPDATE disputes SET status = 'RESOLVED' WHERE id = ?").run(d.id);
  return { outcome: "dispute_stored", orderId: order.id };
}

// ---------- listing for screens ----------

export type DisputeListItem = DisputeRow & { shop_slug: string; title: string };

export function listDisputes(db: DB, shopIds: number[]): DisputeListItem[] {
  if (!shopIds.length) return [];
  const marks = shopIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT d.id, d.order_id, d.paypal_dispute_id, d.status, d.reason, d.amount_cents, d.currency, d.simulated, d.paypal_status,
              d.created_at, d.submitted_at, d.submission_json, '{}' AS evidence_json, s.slug AS shop_slug, COALESCE(p.title, q.sku) AS title
       FROM disputes d JOIN orders o ON o.id = d.order_id JOIN quotes q ON q.id = o.quote_id JOIN shops s ON s.id = o.shop_id
       LEFT JOIN products p ON p.shop_id = o.shop_id AND p.sku = q.sku
       WHERE o.shop_id IN (${marks}) AND d.is_demo = 0 AND o.is_demo = 0 ORDER BY d.rowid DESC`,
    )
    .all(...shopIds) as DisputeListItem[];
}
