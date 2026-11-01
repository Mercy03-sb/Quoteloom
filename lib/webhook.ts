// PayPal webhook receiver logic. Signature first, then dedupe by event id, then a status update.
import { createHmac } from "node:crypto";
import type { DB } from "./db";
import { handleDisputeEvent } from "./disputes";
import type { Client } from "@paypal/paypal-server-sdk";
import { captureCheckout, findOrderByPaypalId, logEvent, loadOrder, OrderError, setStatus, type OrderStatus } from "./orders";
import { SIM_SIGNATURE_HEADER, simWebhookSignature, valueToCents, verifyWebhook, type WebhookHeaders } from "./paypal";
import { signingSecret } from "./quote";

type Env = Record<string, string | undefined>;
type Resource = {
  id?: string;
  amount?: { value?: string; currency_code?: string };
  supplementary_data?: { related_ids?: { order_id?: string } };
};
type PaypalEvent = { id?: string; event_type?: string; resource?: Resource };

export type WebhookResult = { status: number; body: Record<string, unknown> };

/** Key for sim webhooks, derived so it never equals the quote key. */
export function simWebhookSecret(env: Env = process.env): string {
  return createHmac("sha256", signingSecret(env)).update("sim-webhook").digest("hex");
}

/** Event type from a body whose signature failed. Only a plain PayPal-style token is echoed, never arbitrary text. */
function peekEventType(rawBody: string): string {
  try {
    const t = (JSON.parse(rawBody) as { event_type?: unknown }).event_type;
    return typeof t === "string" && /^[A-Z0-9._]{1,60}$/.test(t) ? t : "unknown";
  } catch {
    return "unparseable";
  }
}

/** One console line per webhook received: type, signature result, duplicate or not. No payload, no secrets. */
export function logWebhookLine(eventType: string, signatureOk: boolean, duplicate: boolean): void {
  console.log(`[webhook] type=${eventType} signature=${signatureOk ? "ok" : "failed"} duplicate=${duplicate ? "yes" : "no"}`);
}

const TARGET: Record<string, OrderStatus> = {
  "CHECKOUT.ORDER.APPROVED": "APPROVED",
  "PAYMENT.CAPTURE.COMPLETED": "PAID",
  "PAYMENT.CAPTURE.DENIED": "FAILED",
  "PAYMENT.CAPTURE.DECLINED": "FAILED",
  "PAYMENT.CAPTURE.REFUNDED": "REFUNDED",
  "PAYMENT.CAPTURE.REVERSED": "REFUNDED",
};

export async function handlePaypalWebhook(
  db: DB,
  rawBody: string,
  headers: WebhookHeaders,
  opts: { env?: Env; fetchImpl?: typeof fetch; client?: Client } = {},
): Promise<WebhookResult> {
  const env = opts.env ?? process.env;
  const valid = await verifyWebhook({ headers, rawBody, simSecret: simWebhookSecret(env), env, fetchImpl: opts.fetchImpl });
  if (!valid) {
    logWebhookLine(peekEventType(rawBody), false, false);
    logEvent(db, "webhook.rejected", { reason: "invalid_signature" });
    return { status: 401, body: { error: "invalid_signature" } };
  }

  let event: PaypalEvent;
  try {
    event = JSON.parse(rawBody) as PaypalEvent;
  } catch {
    logWebhookLine("unparseable", true, false);
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof event.id !== "string" || typeof event.event_type !== "string") {
    logWebhookLine("unknown", true, false);
    return { status: 400, body: { error: "missing_event_id_or_type" } };
  }

  const seen = db.prepare("SELECT 1 FROM events WHERE type = 'webhook' AND json_extract(payload_json, '$.id') = ?").get(event.id);
  if (seen) {
    // Keep the duplicate visible in the order's audit log too.
    const dupRes = event.resource ?? {};
    const dupOrderId = event.event_type.startsWith("PAYMENT.CAPTURE.") ? dupRes.supplementary_data?.related_ids?.order_id : dupRes.id;
    const dupOrder = dupOrderId ? findOrderByPaypalId(db, dupOrderId) : undefined;
    logEvent(db, "webhook.duplicate", { id: event.id, event_type: event.event_type, order_id: dupOrder?.id ?? null });
    logWebhookLine(event.event_type, true, true);
    return { status: 200, body: { received: true, duplicate: true } };
  }

  if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) {
    const d = handleDisputeEvent(db, event.event_type, (event.resource ?? {}) as Parameters<typeof handleDisputeEvent>[2]);
    logEvent(db, "webhook", { id: event.id, event_type: event.event_type, order_id: d.orderId, outcome: d.outcome, signature: "valid" });
    logWebhookLine(event.event_type, true, false);
    return { status: 200, body: { received: true, outcome: d.outcome } };
  }

  const res = event.resource ?? {};
  const isCapture = event.event_type.startsWith("PAYMENT.CAPTURE.");
  const paypalOrderId = isCapture ? res.supplementary_data?.related_ids?.order_id : res.id;
  const target = TARGET[event.event_type];
  const order = paypalOrderId ? findOrderByPaypalId(db, paypalOrderId) : undefined;

  let outcome: string;
  if (!target) outcome = "ignored_event_type";
  else if (!order) outcome = "unknown_order";
  else if (
    target === "PAID" &&
    ((res.amount?.value !== undefined && valueToCents(res.amount.value) !== order.amount_cents) ||
      (res.amount?.currency_code !== undefined && res.amount.currency_code !== order.currency))
  ) {
    outcome = "amount_mismatch_ignored";
  } else {
    outcome = setStatus(db, order, target, `webhook:${event.event_type}`) ? `status_${target}` : "no_change";
    if (target === "APPROVED") outcome = await captureApproved(db, order.id, outcome, { env, client: opts.client });
  }

  logEvent(db, "webhook", { id: event.id, event_type: event.event_type, order_id: order?.id ?? null, outcome, signature: "valid" });
  logWebhookLine(event.event_type, true, false);
  return { status: 200, body: { received: true, outcome } };
}

/**
 * The buyer approved at PayPal: capture now, so the order completes even if the buyer never returns to us.
 * Skips orders that are already settled (the return handler may have won the race). A failed capture is
 * recorded in the outcome and never fails the webhook; the return handler or a later capture event can still finish the order.
 */
async function captureApproved(db: DB, orderId: string, prior: string, opts: { env: Env; client?: Client }): Promise<string> {
  const before = loadOrder(db, orderId);
  if (!before || (before.status !== "CREATED" && before.status !== "APPROVED")) return prior === "no_change" ? "already_settled" : prior;
  try {
    await captureCheckout(db, orderId, opts);
    return "captured";
  } catch (e) {
    const code = e instanceof OrderError ? e.code : "error";
    logEvent(db, "order.capture_on_approval_failed", { order_id: orderId, code, error: (e as Error).message });
    return `capture_failed:${code}`;
  }
}

/** Sim mode only: deliver a signed PAYMENT.CAPTURE.COMPLETED to the receiver, as PayPal would. */
export async function simulateCaptureWebhook(db: DB, orderId: string, env: Env = process.env): Promise<WebhookResult | null> {
  const order = loadOrder(db, orderId);
  if (!order) return null;
  const raw = JSON.stringify({
    id: `SIMWH-${crypto.randomUUID()}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: `SIMCAP-${order.id}`,
      amount: { value: (order.amount_cents / 100).toFixed(2), currency_code: order.currency },
      supplementary_data: { related_ids: { order_id: order.paypal_order_id } },
    },
  });
  const headers = new Headers({ [SIM_SIGNATURE_HEADER]: simWebhookSignature(raw, simWebhookSecret(env)) });
  return handlePaypalWebhook(db, raw, headers, { env });
}
