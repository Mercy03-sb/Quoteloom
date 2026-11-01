import Link from "next/link";
import { SubmitEvidenceButton } from "@/components/orders/DisputeActions";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatCents } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { DISPUTE_LABELS } from "@/lib/dispute-labels";
import { getEvidence, loadDispute } from "@/lib/disputes";
import { buildEvidencePacket, sqliteToIso } from "@/lib/evidence";
import { visibleOrder } from "@/lib/orders-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dispute" };

export default async function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const d = loadDispute(db, id);
  if (!d || !visibleOrder(db, await currentWorkspaceId(), d.order_id)) {
    return (
      <div className="page">
        <EmptyState title="Dispute not found" action={<Link className="btn btn-primary" href="/disputes">Back to disputes</Link>}>
          This dispute does not exist, or belongs to another workspace. The demo database resets when the server restarts.
        </EmptyState>
      </div>
    );
  }
  const simulated = d.simulated === 1;
  // Open disputes show a fresh packet from stored data; submitted ones show exactly what was sent.
  let packet = getEvidence(d);
  if (d.status === "OPEN") {
    try {
      packet = buildEvidencePacket(db, { id: d.id, order_id: d.order_id, paypal_dispute_id: d.paypal_dispute_id, reason: d.reason, amount_cents: d.amount_cents, currency: d.currency, opened_at: sqliteToIso(d.created_at) ?? d.created_at, simulated });
    } catch {
      /* keep the stored packet */
    }
  }
  const submission = d.submission_json ? (JSON.parse(d.submission_json) as { mode?: string; simulated?: boolean }) : null;
  const cur = d.currency;
  const m = (c: number) => `${formatCents(c)} ${cur}`;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dispute</h1>
          <p>{DISPUTE_LABELS[d.reason] ?? (d.reason || "No reason given")}, {m(d.amount_cents)}</p>
        </div>
        <div className="row">
          {simulated && <Badge tone="warning">Simulated</Badge>}
          <Badge tone={d.status === "OPEN" ? "warning" : "success"} dot>{d.status === "OPEN" ? "Needs evidence" : d.status === "SUBMITTED" ? "Evidence submitted" : "Resolved"}</Badge>
          <Link className="btn btn-secondary btn-sm" href="/disputes">All disputes</Link>
        </div>
      </div>

      {simulated && (
        <div className="notice" data-tone="warning" style={{ marginBottom: "var(--sp-4)" }}>
          Simulated dispute for the demo. It was created by the Simulate dispute button, not by PayPal. The packet below is built the same way as for a real one.
        </div>
      )}

      {!packet ? (
        <EmptyState title="No evidence packet">The order or quote behind this dispute is gone, so a packet cannot be built.</EmptyState>
      ) : (
        <div className="split">
          <div className="stack">
            <Card title="Checks">
              <ul className="check-list">
                {packet.checks.map((c) => (
                  <li key={c.label}>
                    <span className={`mark ${c.ok ? "ok" : "bad"}`} aria-hidden="true">{c.ok ? "✓" : "✗"}</span>
                    <span><b>{c.label}</b><br /><span className="stat-note">{c.detail}</span></span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Buyer request">
              {packet.buyer_request ? (
                <div className="kv">
                  <span>Requested at</span><b>{packet.buyer_request.ts}</b>
                  <span>Agent</span><b>{packet.buyer_request.agent ?? "unknown"}</b>
                  <span>Item</span><b>{packet.buyer_request.qty} x {packet.buyer_request.sku}</b>
                  <span>Offer</span><b>{packet.buyer_request.offer_price_cents == null ? "none" : `${m(packet.buyer_request.offer_price_cents)} each`}</b>
                </div>
              ) : (
                <p className="stat-note">No request was recorded.</p>
              )}
            </Card>

            <Card title="Negotiation transcript">
              <div className="stack">
                <div className="kv">
                  <span>Outcome</span><b>{(packet.negotiation.outcome ?? "n/a").replace(/_/g, " ")}</b>
                  <span>Offers made</span><b>{packet.negotiation.offers.length}</b>
                </div>
                <ul className="check-list">
                  {packet.negotiation.reasons.map((r, i) => <li key={i}><span className="mark">·</span><span>{r}</span></li>)}
                </ul>
                {packet.negotiation.message && <p className="notice">&ldquo;{packet.negotiation.message}&rdquo;</p>}
                <details>
                  <summary className="stat-note">Raw transcript ({packet.negotiation.transcript.length} entries)</summary>
                  <pre className="json-block">{JSON.stringify(packet.negotiation.transcript, null, 2)}</pre>
                </details>
              </div>
            </Card>
          </div>

          <div className="stack">
            <Card title="Signed quote">
              <div className="kv">
                <span>Quote</span><code className="sig">{packet.quote.id}</code>
                <span>Item</span><b>{packet.quote.qty} x {packet.quote.title}</b>
                <span>Unit price</span><b>{m(packet.quote.unit_price_cents)}</b>
                <span>Expires</span><b>{packet.quote.expires_at}</b>
                <span>Signature</span><b>{packet.quote.signature_intact ? "intact" : "ALTERED"}</b>
                <span>Valid at order</span><b>{packet.quote.valid_when_ordered ? "yes" : "no"}</b>
              </div>
              <p className="stat-note" style={{ marginTop: "var(--sp-2)" }}><Link href={`/quote/${packet.quote.id}`}>Open the quote page</Link></p>
            </Card>

            <Card title="Order and capture">
              <div className="kv">
                <span>Order</span><Link href={`/orders/${packet.order.id}`}>{packet.order.id}</Link>
                <span>Status</span><b>{packet.order.status}</b>
                <span>Charged</span><b>{m(packet.order.amount_cents)}</b>
                <span>Created</span><b>{packet.order.created_at} UTC</b>
                <span>Captured</span><b>{packet.order.captured_at ? `${packet.order.captured_at} UTC` : "no"}</b>
                <span>Capture id</span><code className="sig">{packet.order.capture_id ?? "n/a"}</code>
              </div>
            </Card>

            <Card title="Timeline" flat>
              <ol className="timeline">
                {packet.timeline.map((e, i) => (
                  <li key={i}><time>{e.ts.replace("T", " ").slice(0, 19)} UTC</time><span>{e.detail}</span></li>
                ))}
              </ol>
            </Card>

            <Card title="Approval" flat>
              {d.status === "OPEN" ? (
                <SubmitEvidenceButton disputeId={d.id} simulated={simulated} />
              ) : (
                <div className="stack">
                  <div className="notice" data-tone="success">
                    Evidence submitted {d.submitted_at ? `${d.submitted_at} UTC` : ""}
                    {submission?.simulated ? " (simulated, nothing was sent to PayPal)" : " through the PayPal Disputes API (sandbox)"}.
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
