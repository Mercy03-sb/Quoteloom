"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";

type Props = {
  orderId: string;
  status: string;
  mode: "sim" | "sandbox";
  /** PayPal sent the buyer back with ?paypal=return: capture automatically. */
  returned: boolean;
  approvalUrl: string | null;
};

export function CheckoutActions({ orderId, status, mode, returned, approvalUrl }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const open = status === "CREATED" || status === "APPROVED";

  async function capture() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/capture`, { method: "POST" });
      const body = (await res.json()) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `Capture failed (${res.status})`);
      router.replace(`/checkout/${orderId}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (returned && open && !started.current) {
      started.current = true;
      void capture();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned, open]);

  if (!open) return null;
  return (
    <div className="stack">
      {error && <div className="notice" data-tone="danger" role="alert">{error}</div>}
      {mode === "sim" ? (
        <>
          <div className="notice" data-tone="warning">
            Simulation mode: no PayPal account is involved and nothing leaves this server. Approving here stands in for the PayPal
            approval page.
          </div>
          <Button disabled={busy} onClick={capture}>{busy ? "Processing…" : "Approve and pay (simulated)"}</Button>
        </>
      ) : returned ? (
        <Button disabled={busy} onClick={capture}>{busy ? "Capturing payment…" : "Complete payment"}</Button>
      ) : (
        approvalUrl && <a className="btn btn-primary" href={approvalUrl}>Continue to PayPal sandbox</a>
      )}
    </div>
  );
}
