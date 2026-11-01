"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";

export function QuoteCheckoutButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "checkout", quote_id: quoteId }),
      });
      const out = (await res.json()) as { isError: boolean; result: { message?: string; order_id?: string } };
      if (out.isError || !out.result.order_id) throw new Error(out.result.message ?? "Checkout failed.");
      router.push(`/checkout/${out.result.order_id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error && <div className="notice" data-tone="danger" role="alert">{error}</div>}
      <Button disabled={busy} onClick={go}>{busy ? "Creating order…" : "Check out with PayPal"}</Button>
    </div>
  );
}
