// PayPal webhook receiver logic. Signature first, then dedupe by event id, then a status update.
import { createHmac } from "node:crypto";
import type { DB } from "./db";
import { findOrderByPaypalId, logEvent, loadOrder, setStatus, type OrderStatus } from "./orders";
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
  opts: { env?: Env; fetchImpl?: typeof fetch } = {},
): Promise<WebhookResult> {
  const env = opts.env ?? process.env;
  const valid = await verifyWebhook({ headers, rawBody, simSecret: simWebhookSecret(env), env, fetchImpl: opts.fetchImpl });
  if (!valid) {
    logEvent(db, "webhook.rejected", { reason: "invalid_signature" });
    return { status: 401, body: { error: "invalid_signature" } };
  }

  let event: PaypalEvent;
  try {
    event = JSON.parse(rawBody) as PaypalEvent;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof event.id !== "string" || typeof event.event_type !== "string") {
    return { status: 400, body: { error: "missing_event_id_or_type" } };
  }

  const seen = db.prepare("SELECT 1 FROM events WHERE type = 'webhook' AND json_extract(payload_json, '$.id') = ?").get(event.id);
  if (seen) return { status: 200, body: { received: true, duplicate: true } };

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
  }

  logEvent(db, "webhook", { id: event.id, event_type: event.event_type, order_id: order?.id ?? null, outcome });
  return { status: 200, body: { received: true, outcome } };
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
