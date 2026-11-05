// Pure, client-safe parts of the market reference (types and wording). No server imports here.
export type C3SourceName = "live" | "cached" | "snapshot" | "none";

export const MARKET_NOTE = "Similar items from other retailers, not the same product. Information only; it does not set the price.";

export type MarketReference = {
  status: "ok" | "limited";
  source: C3SourceName;
  label: string;
  currency: string;
  count: number;
  low_cents: number | null;
  median_cents: number | null;
  high_cents: number | null;
  note: string;
  samples: { title: string; retailer: string; price_cents: number }[]; // merchant side only, never a link
};

export const marketLabel = (source: C3SourceName): string =>
  source === "snapshot" ? "Market reference (via Channel3, snapshot)" : "Market reference (via Channel3)";

const money = (c: number, cur: string) => `${(c / 100).toFixed(2)} ${cur}`;

/** One plain line for cards and logs. */
export function marketLine(m: MarketReference): string {
  if (m.status === "limited") return `${m.label}: limited market data (similar items only).`;
  return `${m.label}: ${money(m.low_cents!, m.currency)} to ${money(m.high_cents!, m.currency)}, median ${money(m.median_cents!, m.currency)}, from ${m.count} similar in-stock items. Information only.`;
}

/** Read the market entry back from a stored transcript (null when the quote had none). */
export function marketFromTranscript(transcript: unknown[]): MarketReference | null {
  const e = transcript.find((t) => (t as { type?: string })?.type === "market_reference") as MarketReference | undefined;
  return e && typeof e.label === "string" ? e : null;
}
