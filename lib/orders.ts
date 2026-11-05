// Checkout and order lifecycle: verified quote -> PayPal order -> capture -> PAID.
// Status changes go through one function so webhooks arriving late or twice cannot regress an order.
import { randomBytes } from "node:crypto";
import type { Client } from "@paypal/paypal-server-sdk";
import type { Shop } from "./catalog";
import { paypalMode, type PaypalMode } from "./config";
import type { DB } from "./db";
import { captureOrder, createOrder } from "./paypal";
import { checkQuantity, parseRules } from "./policy";
import { loadVerifiedQuote } from "./quote";

export type OrderStatus = "CREATED" | "APPROVED" | "PAID" | "FAILED" | "REFUNDED";

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["APPROVED", "PAID", "FAILED"],
  APPROVED: ["PAID", "FAILED"],
  FAILED: [],
  PAID: ["REFUNDED"],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return NEXT[from]?.includes(to) ?? false;
}

export type OrderErrorCode = "unknown_order" | "quote_used" | "not_capturable" | "capture_failed" | "amount_mismatch";

export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

export type OrderRecord = {
  id: string;
  shop_id: number;
  shop_slug: string;
  quote_id: string;
  paypal_order_id: string;
  status: OrderStatus;
  amount_cents: number;
  currency: string;
  sku: string;
  title: string;
  qty: number;
  unit_price_cents: number;
  quote_expires_at: string;
  quote_signature: string;
  created_at: string;
  captured_at: string | null;
};

const ORDER_SQL = `
  SELECT o.id, o.shop_id, s.slug AS shop_slug, o.quote_id, o.paypal_order_id, o.status, o.amount_cents,
         q.currency, q.sku, COALESCE(p.title, q.sku) AS title, q.qty, q.price_cents AS unit_price_cents,
         q.expires_at AS quote_expires_at, q.signature AS quote_signature, o.created_at, o.captured_at
  FROM orders o
  JOIN quotes q ON q.id = o.quote_id AND o.is_demo = 0
  JOIN shops s ON s.id = o.shop_id
  LEFT JOIN products p ON p.shop_id = o.shop_id AND p.sku = q.sku`;

export function loadOrder(db: DB, orderId: string): OrderRecord | undefined {
  return db.prepare(`${ORDER_SQL} WHERE o.id = ?`).get(orderId) as OrderRecord | undefined;
}

export function findOrderByPaypalId(db: DB, paypalOrderId: string): OrderRecord | undefined {
  return db.prepare(`${ORDER_SQL} WHERE o.paypal_order_id = ?`).get(paypalOrderId) as OrderRecord | undefined;
}

export function logEvent(db: DB, type: string, payload: unknown): void {
  db.prepare("INSERT INTO events (type, payload_json) VALUES (?, ?)").run(type, JSON.stringify(payload));
}

/** Apply a status change if the transition is allowed. Returns true when the row changed. */
export function setStatus(db: DB, order: OrderRecord, to: OrderStatus, source: string): boolean {
  const current = db.prepare("SELECT status FROM orders WHERE id = ?").get(order.id) as { status: OrderStatus } | undefined;
  if (!current || !canTransition(current.status, to)) return false;
  const run = db.transaction(() => {
    if (to === "PAID") {
      db.prepare("UPDATE orders SET status = ?, captured_at = datetime('now') WHERE id = ?").run(to, order.id);
      // Stock is taken on payment. Never below zero (a sold-out race is reported, not hidden).
      db.prepare("UPDATE products SET stock = MAX(stock - ?, 0) WHERE shop_id = ? AND sku = ?").run(
        order.qty,
        order.shop_id,
        order.sku,
      );
    } else {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(to, order.id);
    }
    logEvent(db, "order.status", { order_id: order.id, from: current.status, to, source });
  });
  run();
  return true;
}

export type Checkout = {
  order_id: string;
  paypal_order_id: string;
  status: OrderStatus;
  approval_url: string;
  amount_cents: number;
  currency: string;
  mode: PaypalMode;
};

type Opts = { now?: Date; secret?: string; env?: Record<string, string | undefined>; client?: Client };

export function checkoutPath(orderId: string): string {
  return `/checkout/${orderId}`;
}

/** Public buyer receipt. The unguessable order id is the only credential. */
export function receiptPath(orderId: string): string {
  return `/receipt/${orderId}`;
}

/** Verify the quote (signature + expiry), then create the PayPal order. One order per quote. */
export async function createCheckout(
  db: DB,
  shop: Shop,
  quoteId: string,
  baseUrl: string,
  opts: Opts = {},
): Promise<Checkout> {
  const quote = loadVerifiedQuote(db, shop, quoteId, opts);

  const existing = db.prepare("SELECT id, status FROM orders WHERE quote_id = ?").get(quote.id) as
    | { id: string; status: string }
    | undefined;
  if (existing) {
    throw new OrderError("quote_used", `This quote already has order ${existing.id} (${existing.status}). Request a new quote to buy again.`);
  }

  // Stock may have changed since the quote; re-apply the quantity rules.
  const product = db.prepare("SELECT stock FROM products WHERE shop_id = ? AND sku = ?").get(shop.id, quote.sku) as
    | { stock: number }
    | undefined;
  const rules = parseRules((db.prepare("SELECT rules_json FROM shops WHERE id = ?").get(shop.id) as { rules_json: string }).rules_json);
  checkQuantity(quote.qty, product?.stock ?? 0, rules);

  const orderId = `ord_${randomBytes(12).toString("hex")}`;
  const page = `${baseUrl}${checkoutPath(orderId)}`; // simulated approval page
  const receiptUrl = `${baseUrl}${receiptPath(orderId)}`; // where PayPal sends the buyer back: a public receipt, not the merchant UI
  const created = await createOrder(
    {
      amountCents: quote.total_cents,
      currency: quote.currency,
      description: `${quote.qty} x ${quote.sku}`,
      referenceId: orderId,
      returnUrl: `${receiptUrl}?paypal=return`,
      cancelUrl: `${receiptUrl}?paypal=cancel`,
    },
    { env: opts.env, client: opts.client },
  );
  db.prepare("INSERT INTO orders (id, shop_id, quote_id, paypal_order_id, status, amount_cents) VALUES (?, ?, ?, ?, 'CREATED', ?)").run(
    orderId,
    shop.id,
    quote.id,
    created.orderId,
    quote.total_cents,
  );
  logEvent(db, "order.created", { order_id: orderId, quote_id: quote.id, paypal_order_id: created.orderId, mode: created.mode });
  return {
    order_id: orderId,
    paypal_order_id: created.orderId,
    status: "CREATED",
    // Simulated approval happens on our own checkout page; sandbox sends the buyer to PayPal.
    approval_url: created.mode === "sim" ? page : created.approvalUrl,
    amount_cents: quote.total_cents,
    currency: quote.currency,
    mode: created.mode,
  };
}

const inflight = new Map<string, Promise<OrderRecord>>();

/**
 * Capture an approved order and mark it PAID. Idempotent for already-paid orders, and safe when the buyer's
 * return and the CHECKOUT.ORDER.APPROVED webhook arrive together: concurrent callers share one capture, and
 * the status change is forward-only, so stock is taken once and PayPal sees one idempotent request.
 */
export function captureCheckout(db: DB, orderId: string, opts: Opts = {}): Promise<OrderRecord> {
  const running = inflight.get(orderId);
  if (running) return running;
  const p = doCapture(db, orderId, opts).finally(() => inflight.delete(orderId));
  inflight.set(orderId, p);
  return p;
}

async function doCapture(db: DB, orderId: string, opts: Opts): Promise<OrderRecord> {
  const order = loadOrder(db, orderId);
  if (!order) throw new OrderError("unknown_order", "No such order.");
  if (order.status === "PAID") return order;
  if (order.status !== "CREATED" && order.status !== "APPROVED") {
    throw new OrderError("not_capturable", `An order that is ${order.status} cannot be captured.`);
  }

  const stock = (db.prepare("SELECT stock FROM products WHERE shop_id = ? AND sku = ?").get(order.shop_id, order.sku) as
    | { stock: number }
    | undefined)?.stock ?? 0;
  if (stock < order.qty) throw new OrderError("capture_failed", "The product sold out before payment. No money was taken.");

  const env = opts.env ?? process.env;
  let captured;
  try {
    captured = await captureOrder(order.paypal_order_id, { amountCents: order.amount_cents, currency: order.currency }, { env, client: opts.client });
  } catch (err) {
    logEvent(db, "order.capture_error", { order_id: order.id, error: (err as Error).message });
    throw new OrderError("capture_failed", (err as Error).message);
  }
  if (captured.status !== "COMPLETED") {
    logEvent(db, "order.capture_incomplete", { order_id: order.id, paypal_status: captured.status });
    throw new OrderError("capture_failed", `PayPal reports the order as ${captured.status}. Approve it in PayPal first.`);
  }
  if (
    (captured.amountCents !== null && captured.amountCents !== order.amount_cents) ||
    (captured.currency !== null && captured.currency !== order.currency)
  ) {
    logEvent(db, "order.amount_mismatch", { order_id: order.id, expected: order.amount_cents, got: captured.amountCents });
    setStatus(db, order, "FAILED", "capture");
    throw new OrderError("amount_mismatch", "Captured amount did not match the signed quote.");
  }
  setStatus(db, order, "PAID", paypalMode(env) === "sim" ? "capture:sim" : "capture");
  logEvent(db, "order.captured", { order_id: order.id, capture_id: captured.captureId, mode: captured.mode });
  return loadOrder(db, orderId)!;
}

export type OrderStatusView = {
  order_id: string;
  status: OrderStatus;
  sku: string;
  title: string;
  qty: number;
  total: string;
  currency: string;
  created_at: string;
  captured_at: string | null;
};

/** Public view for agents. Scoped to the shop and free of internal data. */
export function getOrderStatus(db: DB, shop: Shop, orderId: string): OrderStatusView {
  const o = loadOrder(db, orderId);
  if (!o || o.shop_id !== shop.id) throw new OrderError("unknown_order", "No such order for this shop.");
  return {
    order_id: o.id,
    status: o.status,
    sku: o.sku,
    title: o.title,
    qty: o.qty,
    total: (o.amount_cents / 100).toFixed(2),
    currency: o.currency,
    created_at: o.created_at,
    captured_at: o.captured_at,
  };
}

export type OrderEvent = { type: string; ts: string; detail: string };

/** Audit trail for one order: creation, status changes, captures and webhooks. */
export function orderEvents(db: DB, orderId: string): OrderEvent[] {
  const rows = db
    .prepare("SELECT type, payload_json, ts FROM events WHERE json_extract(payload_json, '$.order_id') = ? ORDER BY id")
    .all(orderId) as { type: string; payload_json: string; ts: string }[];
  return rows.map((r) => {
    const p = JSON.parse(r.payload_json) as Record<string, unknown>;
    const detail =
      r.type === "order.status"
        ? `${p.from} to ${p.to} (${p.source})`
        : r.type === "webhook"
          ? `Webhook received: ${p.event_type}, signature ${p.signature ?? "valid"}, ${p.outcome}`
          : r.type === "webhook.duplicate"
            ? `Webhook received again: ${p.event_type}, signature valid, duplicate ignored`
          : r.type === "order.created"
            ? `PayPal order ${p.paypal_order_id}`
            : r.type === "order.captured"
              ? `capture ${p.capture_id}`
              : JSON.stringify(p);
    return { type: r.type, ts: r.ts, detail };
  });
}
