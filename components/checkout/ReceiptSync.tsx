"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 4000;
const MAX_POLLS = 30; // about two minutes, then the buyer is told to check back

/**
 * Keeps a pending receipt moving. When PayPal sends the buyer back (?paypal=return) it asks the server to capture
 * (idempotent; the CHECKOUT.ORDER.APPROVED webhook may do the same). Then it refreshes until the status settles.
 */
export function ReceiptSync({ orderId, returned, captureHere }: { orderId: string; returned: boolean; captureHere: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const captured = useRef(false);

  useEffect(() => {
    let polls = 0;
    let cancelled = false;
    async function captureOnce() {
      if (!returned || !captureHere || captured.current) return;
      captured.current = true;
      try {
        const res = await fetch(`/api/orders/${orderId}/capture`, { method: "POST" });
        if (res.ok) {
          router.refresh();
        } else {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          if (!cancelled) setError(body.message ?? `We could not confirm the payment yet (${res.status}).`);
        }
      } catch {
        if (!cancelled) setError("We could not reach the server to confirm the payment.");
      }
    }
    void captureOnce();
    const t = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(t);
        if (!cancelled) setGaveUp(true);
        return;
      }
      router.refresh();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [orderId, returned, captureHere, router]);

  return (
    <div className="stack" aria-live="polite">
      {!gaveUp && (
        <p className="stat-note" role="status">
          <span className="skeleton" style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", marginRight: 8 }} aria-hidden="true" />
          Waiting for PayPal to confirm. This page updates by itself.
        </p>
      )}
      {error && <div className="notice" data-tone="warning">{error} We will keep checking.</div>}
      {gaveUp && <div className="notice" data-tone="warning">Still waiting for confirmation. Check back in a minute, or ask your assistant to check the order.</div>}
    </div>
  );
}
