import { marketLine, type MarketReference } from "@/lib/market-view";

type Props = { m: Omit<MarketReference, "samples"> & { samples?: MarketReference["samples"] }; samples?: boolean };

/** "Market reference (via Channel3)" line. Information only. Samples (titles, no links) are shown on the merchant side only. */
export function MarketLine({ m, samples = false }: Props) {
  const full: MarketReference = { ...m, samples: m.samples ?? [] };
  return (
    <div className="market-line" data-testid="market-line" data-status={m.status} data-source={m.source}>
      <p className="stat-note" style={{ margin: 0 }}>
        {marketLine(full)}
      </p>
      <p className="stat-note" style={{ margin: 0 }}>{m.note}</p>
      {samples && full.samples.length > 0 && (
        <ul className="check-list">
          {full.samples.map((s, i) => (
            <li key={i}>
              <span className="mark">·</span>
              <span>
                {s.title} ({s.retailer}): {(s.price_cents / 100).toFixed(2)} {m.currency}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
