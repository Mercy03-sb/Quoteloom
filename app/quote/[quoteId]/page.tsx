import Link from "next/link";
import { QuoteCheckoutButton } from "@/components/checkout/QuoteCheckoutButton";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatCents } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { weaveFor, weaveStyle } from "@/lib/design/weave";
import { inspectQuote } from "@/lib/quote";

export const dynamic = "force-dynamic";
export const metadata = { title: "Signed quote" };

export default async function QuotePage({ params }: { params: Promise<{ quoteId: string }> }) {
  const { quoteId } = await params;
  const info = inspectQuote(getDb(), quoteId);
  if (!info) {
    return (
      <div className="page">
        <EmptyState title="Quote not found" action={<Link className="btn btn-primary" href="/chat">Back to buyer chat</Link>}>
          This quote does not exist. The demo database resets when the server restarts.
        </EmptyState>
      </div>
    );
  }
  const { quote: q, verdict } = info;
  const status = verdict.ok
    ? { tone: "success" as const, label: "Signature valid", note: "The stored terms match the HMAC signature and the quote has not expired." }
    : verdict.code === "expired"
      ? { tone: "warning" as const, label: "Expired", note: "The signature is intact, but the 10-minute window has passed. Request a new quote." }
      : { tone: "danger" as const, label: "Altered", note: "The stored terms do not match the signature. Checkout will refuse this quote." };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Signed quote</h1>
          <p>The price commitment the shop made to the buyer agent. This is the evidence kept for disputes.</p>
        </div>
        <Badge tone={status.tone} dot>{status.label}</Badge>
      </div>

      <div className="split">
        <div className="stack">
          <Card title="Terms">
            <div className="stack">
              <div className="summary-line">
                <div className="summary-swatch" style={weaveStyle(weaveFor({ sku: q.sku, title: info.title }))} aria-hidden="true" />
                <div>
                  <h3>{info.title}</h3>
                  <code className="stat-note">{q.sku}</code>
                </div>
              </div>
              <div className="kv">
                <span>Quantity</span><b>{q.qty}</b>
                <span>Unit price</span><b>{formatCents(q.price_cents)} {q.currency}</b>
                <span>Expires</span><b>{q.expires_at}</b>
                <span>Quote id</span><code className="sig">{q.id}</code>
              </div>
              <div className="totals">
                <span>Total</span>
                <b>{formatCents(q.total_cents)} {q.currency}</b>
              </div>
            </div>
          </Card>

          <div className="notice" data-tone={status.tone === "success" ? "success" : status.tone}>{status.note}</div>

          {info.orderId ? (
            <Link className="btn btn-primary" href={`/checkout/${info.orderId}`}>Go to this quote&apos;s order</Link>
          ) : verdict.ok ? (
            <QuoteCheckoutButton quoteId={q.id} />
          ) : null}
        </div>

        <div className="stack">
          <Card title="Signature" flat>
            <div className="stack">
              <p className="stat-note">HMAC-SHA256 over shop, quote id, SKU, quantity, unit price, currency and expiry.</p>
              <code className="sig">{q.signature}</code>
            </div>
          </Card>
          <Card title="Decision log" flat>
            <ol className="steps" style={{ gap: "var(--sp-2)" }}>
              {info.transcript.map((t, i) => {
                const e = t as Record<string, unknown>;
                return (
                  <li key={i} data-done="true" style={{ alignItems: "flex-start", fontSize: "var(--fs-sm)" }}>
                    <span>
                      <b>{String(e.type)}</b>
                      <br />
                      {e.type === "request"
                        ? `${e.qty} x ${e.sku}${e.offer_cents ? `, offered ${formatCents(Number(e.offer_cents))}` : ""}`
                        : String(e.note ?? "")}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
