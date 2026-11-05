import Link from "next/link";
import { SimulateDisputeButton } from "@/components/orders/DisputeActions";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";
import { formatCents } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { sqliteToIso } from "@/lib/evidence";
import { orderEvents, type OrderStatus } from "@/lib/orders";
import { visibleOrder } from "@/lib/orders-view";
import { MarketLine } from "@/components/market/MarketLine";
import { marketFromTranscript } from "@/lib/market-view";
import { inspectQuote } from "@/lib/quote";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order" };

const TONE: Record<OrderStatus, BadgeTone> = { CREATED: "warning", APPROVED: "accent", PAID: "success", FAILED: "danger", REFUNDED: "neutral" };

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const order = visibleOrder(db, await currentWorkspaceId(), id);
  if (!order) {
    return (
      <div className="page">
        <EmptyState title="Order not found" action={<Link className="btn btn-primary" href="/orders">Back to orders</Link>}>
          This order does not exist, or belongs to another workspace. The demo database resets when the server restarts.
        </EmptyState>
      </div>
    );
  }
  const info = inspectQuote(db, order.quote_id);
  const transcript = (info?.transcript ?? []) as Record<string, unknown>[];
  const market = marketFromTranscript(transcript);
  const decision = transcript.find((e) => e.type === "decision");
  const message = transcript.find((e) => e.type === "message");
  const request = transcript.find((e) => e.type === "request");
  const events = orderEvents(db, order.id);
  const disputes = db
    .prepare("SELECT id, status, simulated, created_at FROM disputes WHERE order_id = ? ORDER BY rowid")
    .all(order.id) as { id: string; status: string; simulated: number; created_at: string }[];
  const cur = order.currency;
  const list = decision?.list_price_cents == null ? null : Number(decision.list_price_cents);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Order</h1>
          <p><code>{order.id}</code></p>
        </div>
        <div className="row">
          <Badge tone={TONE[order.status]} dot>{order.status}</Badge>
          <Link className="btn btn-ghost btn-sm" href={`/receipt/${order.id}`}>Buyer receipt</Link>
          <Link className="btn btn-secondary btn-sm" href="/orders">All orders</Link>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <Card title="What was bought">
            <div className="kv">
              <span>Product</span><b>{order.title}</b>
              <span>SKU</span><code>{order.sku}</code>
              <span>Quantity</span><b>{order.qty}</b>
              <span>Unit price</span><b>{formatCents(order.unit_price_cents)} {cur}</b>
              <span>Total</span><b>{formatCents(order.amount_cents)} {cur}</b>
              <span>Created</span><b>{order.created_at} UTC</b>
              <span>Captured</span><b>{order.captured_at ? `${order.captured_at} UTC` : "not yet"}</b>
              <span>PayPal order</span><code className="sig">{order.paypal_order_id}</code>
            </div>
          </Card>

          <Card title="Negotiation">
            {decision ? (
              <div className="stack">
                <div className="kv">
                  <span>List price</span><b>{list === null ? "n/a" : `${formatCents(list)} ${cur}`}</b>
                  <span>Buyer offered</span><b>{request?.offer_cents == null ? "no offer" : `${formatCents(Number(request.offer_cents))} ${cur}`}</b>
                  <span>Agreed unit price</span><b>{formatCents(order.unit_price_cents)} {cur}</b>
                  <span>Outcome</span><b>{String(decision.outcome ?? "list_price").replace(/_/g, " ")}</b>
                </div>
                {Array.isArray(decision.reasons) && (
                  <ul className="check-list">
                    {(decision.reasons as string[]).map((r, i) => <li key={i}><span className="mark">·</span><span>{r}</span></li>)}
                  </ul>
                )}
                {message && <p className="notice">&ldquo;{String(message.text)}&rdquo; <span className="stat-note">({String(message.source)} wording; the price was set by the shop&apos;s rules)</span></p>}
              </div>
            ) : (
              <p className="stat-note">No decision log is stored for this quote.</p>
            )}
            {market && <div style={{ marginTop: "var(--sp-3)" }}><MarketLine m={market} samples /></div>}
            {info && <p className="stat-note" style={{ marginTop: "var(--sp-3)" }}><Link href={`/quote/${info.quote.id}`}>Open the signed quote</Link></p>}
          </Card>

          <Card title="Audit trail">
            <ol className="timeline">
              {events.map((e, i) => (
                <li key={i}><time>{sqliteToIso(e.ts)?.replace("T", " ").slice(0, 19)} UTC</time><span><b>{e.type}</b> {e.detail}</span></li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="stack">
          <Card title="Disputes" flat>
            {disputes.length === 0 ? (
              <p className="stat-note">No disputes on this order.</p>
            ) : (
              <ul className="check-list">
                {disputes.map((d) => (
                  <li key={d.id}>
                    <Link href={`/disputes/${d.id}`}>{d.id}</Link>
                    <Badge tone={d.status === "OPEN" ? "warning" : "success"}>{d.status}</Badge>
                    {d.simulated === 1 && <Badge>Simulated</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {order.status === "PAID" ? (
            <Card title="Demo" flat><SimulateDisputeButton orderId={order.id} /></Card>
          ) : (
            <p className="stat-note">A dispute can be simulated once the order is paid.</p>
          )}
        </div>
      </div>
    </div>
  );
}
