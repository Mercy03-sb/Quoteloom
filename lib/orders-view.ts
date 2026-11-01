// Read models for the Orders and Disputes screens. Always scoped to the shops a workspace may see.
import type { DB } from "./db";
import { loadOrder, type OrderRecord } from "./orders";
import { visibleShops } from "./workspace";

export type OrderListItem = {
  id: string;
  shop_slug: string;
  sku: string;
  title: string;
  qty: number;
  status: string;
  amount_cents: number;
  currency: string;
  unit_price_cents: number;
  list_price_cents: number | null;
  negotiated: boolean;
  disputes: number;
  created_at: string;
  captured_at: string | null;
};

export function visibleShopIds(db: DB, workspaceId: string | null): number[] {
  return visibleShops(db, workspaceId).map((s) => s.id);
}

export function listOrders(db: DB, shopIds: number[]): OrderListItem[] {
  if (!shopIds.length) return [];
  const marks = shopIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT o.id, s.slug AS shop_slug, q.sku, COALESCE(p.title, q.sku) AS title, q.qty, o.status, o.amount_cents, q.currency,
              q.price_cents AS unit_price_cents, o.created_at, o.captured_at, q.transcript_json,
              (SELECT COUNT(*) FROM disputes d WHERE d.order_id = o.id) AS disputes
       FROM orders o JOIN quotes q ON q.id = o.quote_id JOIN shops s ON s.id = o.shop_id
       LEFT JOIN products p ON p.shop_id = o.shop_id AND p.sku = q.sku
       WHERE o.shop_id IN (${marks}) ORDER BY o.rowid DESC`,
    )
    .all(...shopIds) as (Omit<OrderListItem, "list_price_cents" | "negotiated"> & { transcript_json: string })[];
  return rows.map(({ transcript_json, ...r }) => {
    let list: number | null = null;
    try {
      const d = (JSON.parse(transcript_json) as Record<string, unknown>[]).find((e) => e.type === "decision");
      if (d?.list_price_cents != null) list = Number(d.list_price_cents);
    } catch {
      /* no transcript */
    }
    return { ...r, list_price_cents: list, negotiated: list !== null && list !== r.unit_price_cents };
  });
}

/** An order, only if its shop is visible to this workspace. */
export function visibleOrder(db: DB, workspaceId: string | null, orderId: string): OrderRecord | undefined {
  const o = loadOrder(db, orderId);
  return o && visibleShopIds(db, workspaceId).includes(o.shop_id) ? o : undefined;
}
