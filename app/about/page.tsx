import { Card } from "@/components/ui";
import { BUILT_WITH } from "@/lib/built-with";

export const metadata = { title: "About" };

export default function AboutPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>About Quoteloom</h1>
          <p>
            Paste a small shop&apos;s URL or upload a CSV and Quoteloom builds an agent-ready storefront: a catalog, merchant rules and a hosted MCP endpoint.
            Buyer agents search, negotiate and pay with PayPal sandbox. Every purchase keeps a signed quote as evidence for disputes.
          </p>
        </div>
      </div>

      <Card title="Ground rules">
        <ul className="check-list">
          <li><span className="mark">·</span><span>Fake data and PayPal sandbox only. No real money, no real customers.</span></li>
          <li><span className="mark">·</span><span>Prices are decided by the shop&apos;s rules in code. No model and no outside service ever sets a price.</span></li>
          <li><span className="mark">·</span><span>The app starts with no keys at all. Every outside service has a fallback.</span></li>
          <li><span className="mark">·</span><span>State is disposable: the database is re-seeded on every start.</span></li>
        </ul>
      </Card>

      <Card title="Built with">
        <dl className="built-with">
          {BUILT_WITH.map((t) => (
            <div key={t.name}>
              <dt>{t.name}</dt>
              <dd>{t.how}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
