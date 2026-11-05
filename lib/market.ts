// Market reference from Channel3: information only. lib/policy.ts alone decides the price.
// Channel3 search is semantic, so these are SIMILAR items, never the same product. No offer URLs are kept here,
// so nothing in a MarketReference can leak a retailer link into buyer-facing negotiation.
import type { DB } from "./db";
import { lookupChannel3, type C3Lookup, type LookupCtx } from "./channel3";
import { MARKET_NOTE, marketLabel, marketLine, type MarketReference } from "./market-view";

export { MARKET_NOTE, marketLabel, marketLine, marketFromTranscript, type MarketReference } from "./market-view";

export const MIN_MARKET_OFFERS = 2;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Median, low and high of in-stock offers in the shop's currency. Fewer than two usable offers: "limited". */
export function computeMarket(lookup: Pick<C3Lookup, "source" | "products">, currency: string): MarketReference {
  const cur = currency.toUpperCase();
  const usable = lookup.products.filter((p) => p.in_stock && p.currency === cur && Number.isFinite(p.price) && p.price > 0);
  const cents = usable.map((p) => Math.round(p.price * 100));
  const base = { source: lookup.source, label: marketLabel(lookup.source), currency: cur, count: usable.length, note: MARKET_NOTE };
  if (usable.length < MIN_MARKET_OFFERS) {
    return { ...base, status: "limited", low_cents: null, median_cents: null, high_cents: null, samples: [] };
  }
  return {
    ...base,
    status: "ok",
    low_cents: Math.min(...cents),
    median_cents: median(cents),
    high_cents: Math.max(...cents),
    samples: usable.slice(0, 3).map((p) => ({ title: p.title, retailer: p.retailer, price_cents: Math.round(p.price * 100) })),
  };
}

export async function marketReference(db: DB, productTitle: string, currency: string, ctx: LookupCtx = {}): Promise<MarketReference> {
  return computeMarket(await lookupChannel3(db, productTitle, ctx), currency);
}

/** Buyer-safe view for the MCP result: statistics and label only, no samples, no links. */
export function publicMarket(m: MarketReference) {
  const rest: Omit<MarketReference, "samples"> & { samples?: unknown } = { ...m };
  delete rest.samples;
  return { ...rest, summary: marketLine(m) };
}
