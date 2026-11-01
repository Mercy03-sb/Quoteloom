// Public buyer receipt: the only view of an order that needs no workspace. It is built from a short allow-list of
// fields, so nothing merchant-side (cost, floor, margin, rules, quote transcript, audit events) can reach it.
import type { DB } from "./db";
import { loadOrder, type OrderStatus } from "./orders";

export type Receipt = {
  order_id: string;
  status: OrderStatus;
  shop_name: string;
  title: string;
  sku: string;
  qty: number;
  unit_price_cents: number;
  amount_cents: number;
  currency: string;
  captured_at: string | null;
  simulated: boolean;
};

export function loadReceipt(db: DB, orderId: string): Receipt | undefined {
  const o = loadOrder(db, orderId);
  if (!o) return undefined;
  const shop = db.prepare("SELECT name FROM shops WHERE id = ?").get(o.shop_id) as { name: string } | undefined;
  return {
    order_id: o.id,
    status: o.status,
    shop_name: shop?.name ?? o.shop_slug,
    title: o.title,
    sku: o.sku,
    qty: o.qty,
    unit_price_cents: o.unit_price_cents,
    amount_cents: o.amount_cents,
    currency: o.currency,
    captured_at: o.captured_at,
    simulated: o.paypal_order_id.startsWith("SIM-"),
  };
}
