import Link from "next/link";
import { CheckoutActions } from "@/components/checkout/CheckoutActions";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";
import { formatCents } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { weaveFor, weaveStyle } from "@/lib/design/weave";
import { loadOrder, orderEvents, type OrderStatus } from "@/lib/orders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checkout" };

const TONE: Record<OrderStatus, BadgeTone> = { CREATED: "warning", APPROVED: "accent", PAID: "success", FAILED: "danger", REFUNDED: "neutral" };

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ paypal?: string }>;
}) {
  const { orderId } = await params;
  const { paypal } = await searchParams;
  const db = getDb();
  const order = loadOrder(db, orderId);
  if (!order) {
    return (
      <div className="page">
        <EmptyState
          title="Order not found"
          action={<Link className="btn btn-primary" href="/playground">Back to the playground</Link>}
        >
          This order does not exist. The demo database resets when the server restarts.
        </EmptyState>
      </div>
    );
  }
  const sim = order.paypal_order_id.startsWith("SIM-");
  const events = orderEvents(db, order.id);
  const rank = { CREATED: 1, APPROVED: 2, PAID: 3, FAILED: 1, REFUNDED: 3 }[order.status];
  const steps = ["Quote signed", "Order created", "Payment approved", "Paid"];
  const done = [true, true, rank >= 2 || order.status === "PAID", order.status === "PAID" || order.status === "REFUNDED"];
  const currentIdx = done.findIndex((d) => !d);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Checkout</h1>
          <p>Order <code>{order.id}</code></p>
        </div>
        <div className="row">
          <Badge tone={sim ? "warning" : "success"} dot>{sim ? "Simulation mode" : "Live sandbox"}</Badge>
          <Badge tone={TONE[order.status]}>{order.status}</Badge>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <Card title="Order summary">
            <div className="stack">
              <div className="summary-line">
                <div className="summary-swatch" style={weaveStyle(weaveFor({ sku: order.sku, title: order.title }))} aria-hidden="true" />
                <div>
                  <h3>{order.title}</h3>
                  <code className="stat-note">{order.sku}</code>
                </div>
              </div>
              <div className="kv">
                <span>Quantity</span><b>{order.qty}</b>
                <span>Unit price</span><b>{formatCents(order.unit_price_cents)} {order.currency}</b>
              </div>
              <div className="totals">
                <span>Total</span>
                <b>{formatCents(order.amount_cents)} {order.currency}</b>
              </div>
            </div>
          </Card>

          {order.status === "PAID" && (
            <div className="notice" data-tone="success" role="status">
              Payment received{order.captured_at ? ` at ${order.captured_at} UTC` : ""}. {sim ? "This was a simulated payment." : "Sandbox payment, no real money."}
            </div>
          )}
          {order.status === "FAILED" && (
            <div className="notice" data-tone="danger" role="alert">
              This payment failed. Ask the buyer agent for a new quote to try again.
            </div>
          )}
          {paypal === "cancel" && order.status !== "PAID" && (
            <div className="notice" data-tone="warning">Payment was cancelled at PayPal. You can try again below.</div>
          )}

          <CheckoutActions
            orderId={order.id}
            status={order.status}
            mode={sim ? "sim" : "sandbox"}
            returned={paypal === "return"}
            approvalUrl={sim ? null : `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(order.paypal_order_id)}`}
          />
          <div className="row">
            <Link className="btn btn-secondary btn-sm" href={`/quote/${order.quote_id}`}>View signed quote</Link>
            <Link className="btn btn-ghost btn-sm" href={`/receipt/${order.id}`}>Buyer receipt</Link>
            <Link className="btn btn-ghost btn-sm" href="/playground">Back to the playground</Link>
          </div>
        </div>

        <div className="stack">
          <Card title="Progress">
            <ol className="steps">
              {steps.map((s, i) => (
                <li key={s} data-done={done[i]} data-current={i === currentIdx}>{s}</li>
              ))}
            </ol>
          </Card>
          <Card title="Audit log" flat>
            {events.length === 0 ? (
              <p className="stat-note">No events yet.</p>
            ) : (
              <ul className="steps" style={{ gap: "var(--sp-2)" }}>
                {events.map((e, i) => (
                  <li key={i} data-done="true" style={{ alignItems: "flex-start", fontSize: "var(--fs-sm)" }}>
                    <span>
                      <code>{e.type}</code> <span className="stat-note">{e.ts}</span>
                      <br />
                      {e.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
