import { formatCents, listProducts, type Shop } from "@/lib/catalog";
import { llmMode, paypalMode } from "@/lib/config";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function Home() {
  const db = getDb();
  const shops = db.prepare("SELECT id, slug, name, source_url FROM shops ORDER BY id").all() as Shop[];

  return (
    <main>
      <h1>Quoteloom</h1>
      <p>
        PayPal: <b>{paypalMode()}</b> · LLM: <b>{llmMode()}</b> · Fake demo data only.
      </p>
      {shops.map((shop) => (
        <section key={shop.id}>
          <h2>{shop.name}</h2>
          <p>
            MCP endpoint: <code>/m/{shop.slug}/mcp</code>
          </p>
          <table cellPadding={4} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
                <th>SKU</th>
                <th>Title</th>
                <th style={{ textAlign: "right" }}>Price</th>
                <th style={{ textAlign: "right" }}>Stock</th>
              </tr>
            </thead>
            <tbody>
              {listProducts(db, shop.id).map((p) => (
                <tr key={p.sku}>
                  <td>
                    <code>{p.sku}</code>
                  </td>
                  <td>{p.title}</td>
                  <td style={{ textAlign: "right" }}>
                    {formatCents(p.price_cents)} {p.currency}
                  </td>
                  <td style={{ textAlign: "right" }}>{p.stock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
