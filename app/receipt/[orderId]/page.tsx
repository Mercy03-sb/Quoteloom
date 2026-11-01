import { ReceiptSync } from "@/components/checkout/ReceiptSync";
import { Badge, Card } from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";
import { formatCents } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { weaveFor, weaveStyle } from "@/lib/design/weave";
import type { OrderStatus } from "@/lib/orders";
import { loadReceipt } from "@/lib/receipt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Receipt", robots: { index: false, follow: false } };

const VIEW: Record<OrderStatus, { tone: BadgeTone; badge: string; heading: string; note: string; role: "status" | "alert" }> = {
  PAID: { tone: "success", badge: "Paid", heading: "Payment received", note: "Thank you. Your order is paid.", role: "status" },
  CREATED: { tone: "warning", badge: "Pending", heading: "Payment pending", note: "We have not received the payment yet.", role: "status" },
  APPROVED: { tone: "warning", badge: "Processing", heading: "Payment processing", note: "PayPal has approved the payment and we are completing it.", role: "status" },
  FAILED: { tone: "danger", badge: "Failed", heading: "Payment failed", note: "The payment did not go through and you were not charged for this order. Ask your assistant for a new quote to try again.", role: "alert" },
  REFUNDED: { tone: "neutral", badge: "Refunded", heading: "Payment refunded", note: "This payment has been refunded.", role: "status" },
};

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ paypal?: string }>;
}) {
  const { orderId } = await params;
  const { paypal } = await searchParams;
  const r = loadReceipt(getDb(), orderId);

  if (!r) {
    return (
      <div className="receipt-card">
        <div className="notice" data-tone="warning" role="alert" data-testid="receipt-not-found">
          <b>We could not find this order.</b>
          <br />
          The link may be mistyped, or this demo server was restarted (its data resets on restart). Ask your assistant to check the order with get_order_status.
        </div>
      </div>
    );
  }

  const v = VIEW[r.status];
  const pending = r.status === "CREATED" || r.status === "APPROVED";
  const cancelled = paypal === "cancel" && pending;
  return (
    <div className="receipt-card">
      <Card>
        <div className="stack">
          <div className="card-head card-head-tight">
            <p className="stat-note" style={{ margin: 0 }}>{r.shop_name}</p>
            <Badge tone={v.tone} dot>{v.badge}</Badge>
          </div>
          <h1 className="receipt-title">{cancelled ? "Payment cancelled" : v.heading}</h1>
          <div className="notice" data-tone={cancelled ? "warning" : v.tone === "neutral" ? undefined : v.tone} role={v.role}>
            {cancelled ? "You cancelled at PayPal, so nothing was charged. Ask your assistant to start the checkout again." : v.note}
            {r.status === "PAID" && (r.simulated ? " This was a simulated payment." : " This was a PayPal sandbox payment, no real money.")}
          </div>

          <div className="summary-line">
            <div className="summary-swatch" style={weaveStyle(weaveFor({ sku: r.sku, title: r.title }))} aria-hidden="true" />
            <div>
              <h3>{r.title}</h3>
              <code className="stat-note">{r.sku}</code>
            </div>
          </div>
          <div className="kv">
            <span>Quantity</span><b>{r.qty}</b>
            <span>Unit price</span><b>{formatCents(r.unit_price_cents)} {r.currency}</b>
            <span>Order</span><code className="sig">{r.order_id}</code>
            {r.captured_at && (<><span>Paid</span><b>{r.captured_at} UTC</b></>)}
          </div>
          <div className="totals">
            <span>Total</span>
            <b>{formatCents(r.amount_cents)} {r.currency}</b>
          </div>

          {pending && !cancelled && <ReceiptSync orderId={r.order_id} returned={paypal === "return"} captureHere={!r.simulated} />}
          <p className="stat-note">
            Your assistant can check this order at any time with <code>get_order_status</code> and the order id above.
          </p>
        </div>
      </Card>
    </div>
  );
}
