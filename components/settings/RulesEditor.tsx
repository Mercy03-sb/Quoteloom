"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import type { ShopRules } from "@/lib/policy";

type BreakDraft = { min_qty: string; discount_pct: string };

/** Merchant rules for negotiation. The server re-validates everything; this only gives quick feedback. */
export function RulesEditor({ slug, initial, readOnly }: { slug: string; initial: ShopRules; readOnly: boolean }) {
  const [negotiation, setNegotiation] = useState(initial.negotiation);
  const [maxDiscount, setMaxDiscount] = useState(String(initial.max_discount_pct));
  const [minMargin, setMinMargin] = useState(String(initial.min_margin_pct));
  const [maxQty, setMaxQty] = useState(String(initial.max_qty));
  const [breaks, setBreaks] = useState<BreakDraft[]>(initial.quantity_breaks.map((b) => ({ min_qty: String(b.min_qty), discount_pct: String(b.discount_pct) })));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/shops/${encodeURIComponent(slug)}/rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          negotiation,
          max_discount_pct: Number(maxDiscount),
          min_margin_pct: Number(minMargin),
          max_qty: Number(maxQty),
          quantity_breaks: breaks.map((b) => ({ min_qty: Number(b.min_qty), discount_pct: Number(b.discount_pct) })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg(res.ok ? { tone: "success", text: "Rules saved. New quotes use them straight away." } : { tone: "danger", text: data.message ?? "Could not save the rules." });
    } catch {
      setMsg({ tone: "danger", text: "Network error. Try again." });
    }
    setBusy(false);
  }

  const off = readOnly || busy;
  return (
    <form className="rules-form" onSubmit={save} aria-label="Merchant rules">
      <label className="toolbar-check" style={{ fontWeight: 600 }}>
        <input type="checkbox" checked={negotiation} disabled={readOnly} onChange={(e) => setNegotiation(e.target.checked)} /> Allow buyer agents to negotiate
      </label>
      <div className="rules-grid">
        <label className="field">
          <span>Max discount (%)</span>
          <input type="number" min={0} max={90} step="any" value={maxDiscount} disabled={readOnly} onChange={(e) => setMaxDiscount(e.target.value)} />
          <span className="stat-note">Never go below this much off the list price.</span>
        </label>
        <label className="field">
          <span>Minimum margin (%)</span>
          <input type="number" min={0} max={99} step="any" value={minMargin} disabled={readOnly} onChange={(e) => setMinMargin(e.target.value)} />
          <span className="stat-note">Applied when a product has a cost. Without one only the max discount counts.</span>
        </label>
        <label className="field">
          <span>Max quantity per order</span>
          <input type="number" min={1} max={1000} step={1} value={maxQty} disabled={readOnly} onChange={(e) => setMaxQty(e.target.value)} />
        </label>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, fontSize: "var(--fs-sm)", marginBottom: "var(--sp-2)" }}>Quantity breaks</legend>
        <div className="stack">
          {breaks.length === 0 && <p className="stat-note">No quantity discounts. Buyers pay list price unless they negotiate.</p>}
          {breaks.map((b, i) => (
            <div className="break-row" key={i}>
              <label className="field">
                <span>From quantity</span>
                <input type="number" min={2} step={1} value={b.min_qty} disabled={readOnly} onChange={(e) => setBreaks((cur) => cur.map((x, j) => (j === i ? { ...x, min_qty: e.target.value } : x)))} />
              </label>
              <label className="field">
                <span>Discount (%)</span>
                <input type="number" min={0.1} max={90} step="any" value={b.discount_pct} disabled={readOnly} onChange={(e) => setBreaks((cur) => cur.map((x, j) => (j === i ? { ...x, discount_pct: e.target.value } : x)))} />
              </label>
              <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => setBreaks((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove break ${i + 1}`}>Remove</Button>
            </div>
          ))}
          <div>
            <Button variant="secondary" size="sm" disabled={readOnly || breaks.length >= 4} onClick={() => setBreaks((cur) => [...cur, { min_qty: "", discount_pct: "" }])}>Add a break</Button>
          </div>
        </div>
      </fieldset>

      {msg && <div className="notice" data-tone={msg.tone} role={msg.tone === "danger" ? "alert" : "status"}>{msg.text}</div>}
      <div className="row">
        <Button type="submit" disabled={off}>{busy ? "Saving…" : "Save rules"}</Button>
      </div>
    </form>
  );
}
