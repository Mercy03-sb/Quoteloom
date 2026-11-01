"use client";

import { useState } from "react";
import { Badge, Button } from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";
import type { QuantityBreak } from "@/lib/policy";

export type QuoteResult = Record<string, unknown>;

const OUTCOME: Record<string, { label: string; tone: BadgeTone }> = {
  accepted: { label: "Offer accepted", tone: "success" },
  countered: { label: "Best price right now", tone: "warning" },
  negotiation_off: { label: "Shop does not negotiate", tone: "neutral" },
  offer_not_lower: { label: "Offer not below price", tone: "neutral" },
  final_price: { label: "Final price", tone: "warning" },
};

type Negotiation = { outcome?: string; list_price?: string; offered?: string | null; final_unit_price?: string; reasons?: string[] };

/** What the shop said to an offer: outcome, the three prices, the reasons and the reply. Shown on the new quote card. */
export function NegotiationResult({ r }: { r: QuoteResult }) {
  const n = (r.negotiation ?? {}) as Negotiation;
  if (!n.offered) return null;
  const o = OUTCOME[n.outcome ?? ""] ?? { label: "Decision", tone: "neutral" as BadgeTone };
  const cur = String(r.currency);
  const reasons = Array.isArray(n.reasons) ? n.reasons : [];
  return (
    <div className="negotiation" data-testid="negotiation-result">
      <div className="row">
        <Badge tone={o.tone} dot>{o.label}</Badge>
        <span className="stat-note">You offered {n.offered} {cur}, list price {n.list_price} {cur}</span>
      </div>
      {reasons.length > 0 && (
        <ul className="check-list" aria-label="Decision reasons">
          {reasons.map((x, i) => <li key={i}><span className="mark">·</span><span>{x}</span></li>)}
        </ul>
      )}
      {typeof r.message === "string" && r.message && <p className="notice">&ldquo;{r.message}&rdquo;</p>}
    </div>
  );
}

function BreakList({ breaks, qty, list, cur }: { breaks: QuantityBreak[]; qty: number; list: number; cur: string }) {
  if (breaks.length === 0) return <p className="stat-note">This shop has no quantity discounts.</p>;
  const pct = breaks.reduce((p, b) => (qty >= b.min_qty ? b.discount_pct : p), 0); // breaks arrive sorted by min_qty
  const next = breaks.find((b) => b.min_qty > qty);
  return (
    <div className="stack" style={{ gap: "var(--sp-1)" }}>
      <ul className="check-list" aria-label="Quantity discounts">
        {breaks.map((b) => {
          const on = qty >= b.min_qty && b.discount_pct === pct;
          return (
            <li key={b.min_qty} data-active={on}>
              <span className={`mark ${on ? "ok" : ""}`} aria-hidden="true">{on ? "✓" : "·"}</span>
              <span>
                {b.min_qty}+ units: {b.discount_pct}% off
                {list > 0 && <span className="stat-note"> ({(list * (1 - b.discount_pct / 100)).toFixed(2)} {cur} each)</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="stat-note" role="status">
        {pct > 0 ? `At ${qty} you get ${pct}% off.` : `No discount at ${qty}.`}
        {next ? ` Add ${next.min_qty - qty} more for ${next.discount_pct}% off.` : ""} The signed quote is the final word.
      </p>
    </div>
  );
}

/**
 * Quantity (with live quantity-break discounts) and "Make an offer" for the newest quote.
 * onSubmit(qty, offer?) asks the shop for a new signed quote; it resolves when the reply is in the chat.
 */
export function OfferPanel({ r, busy, onSubmit }: { r: QuoteResult; busy: boolean; onSubmit: (qty: number, offer?: number) => void }) {
  const currentQty = Number(r.qty);
  const [qty, setQty] = useState(String(currentQty));
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const breaks = (Array.isArray(r.quantity_discounts) ? r.quantity_discounts : []) as QuantityBreak[];
  const list = Number(r.list_price);
  const cur = String(r.currency);
  const qtyN = Number(qty);
  const qtyOk = Number.isInteger(qtyN) && qtyN >= 1 && qtyN <= 1000;

  function offer(e: React.FormEvent) {
    e.preventDefault();
    const p = Number(price);
    if (!qtyOk) return setError("Enter a whole quantity of 1 or more.");
    if (!price.trim() || !Number.isFinite(p) || p <= 0) return setError("Enter the unit price you want to pay, for example 40.00.");
    if (Math.round(p * 100) / 100 !== p) return setError("Use at most two decimals, for example 40.00.");
    setError(null);
    onSubmit(qtyN, p);
  }

  return (
    <form className="offer-panel" noValidate onSubmit={offer} aria-label="Quantity and offer">
      <div className="offer-fields">
        <label className="field">
          <span>Quantity</span>
          <input type="number" inputMode="numeric" min={1} max={1000} step={1} value={qty} disabled={busy} onChange={(e) => { setQty(e.target.value); setError(null); }} />
        </label>
        <label className="field">
          <span>Your offer per unit ({cur})</span>
          <input type="number" inputMode="decimal" min={0} step="0.01" placeholder={String(r.unit_price)} value={price} disabled={busy} onChange={(e) => { setPrice(e.target.value); setError(null); }} />
        </label>
      </div>
      <BreakList breaks={breaks} qty={qtyOk ? qtyN : currentQty} list={list} cur={cur} />
      {error && <div className="notice" data-tone="danger" role="alert">{error}</div>}
      <div className="row">
        <Button type="submit" size="sm" variant="secondary" disabled={busy}>{busy ? "Asking the shop…" : "Make an offer"}</Button>
        {qtyOk && qtyN !== currentQty && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSubmit(qtyN)}>Re-quote at {qtyN}</Button>
        )}
      </div>
    </form>
  );
}
