"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";

async function post(url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Demo action on a paid order: opens a SIMULATED dispute (never contacts PayPal). */
export function SimulateDisputeButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    const r = await post("/api/disputes/simulate", { order_id: orderId });
    if (r.ok) router.push(`/disputes/${String(r.data.dispute_id)}`);
    else {
      setError(String(r.data.message ?? "Could not create the dispute."));
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      {error && <div className="notice" data-tone="danger" role="alert">{error}</div>}
      <Button variant="secondary" disabled={busy} onClick={go}>{busy ? "Creating…" : "Simulate dispute"}</Button>
      <p className="stat-note">Demo only: creates a simulated dispute and builds the evidence packet. Nothing is sent to PayPal.</p>
    </div>
  );
}

/** The merchant's approval: submit the evidence packet. */
export function SubmitEvidenceButton({ disputeId, simulated }: { disputeId: string; simulated: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    const r = await post(`/api/disputes/${disputeId}/submit`);
    if (r.ok) router.refresh();
    else {
      setError(String(r.data.message ?? "Submission failed."));
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      {error && <div className="notice" data-tone="danger" role="alert">{error}</div>}
      <Button disabled={busy} onClick={go}>{busy ? "Submitting…" : simulated ? "Approve and submit (simulated)" : "Approve and submit evidence"}</Button>
      <p className="stat-note">
        {simulated
          ? "This dispute is simulated, so the evidence is built exactly as for PayPal but the final request is skipped."
          : "Sends this packet to PayPal's Disputes API (sandbox)."}
      </p>
    </div>
  );
}
