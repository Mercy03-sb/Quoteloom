import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/studio/data/route";
import { seedDemoHistory } from "@/lib/demo-history";
import { createShop } from "@/lib/shops";
import { STUDIO_FIELDS, STUDIO_TABLES } from "@/lib/studio-data";
import { resolveWorkspace } from "@/lib/workspace";
import { installTestDb } from "./helpers";

const U = "http://localhost:3000/api/studio/data";
const product = { sku: "S-1", title: "Thing", description: "", price_cents: 900, currency: "USD", stock: 3 };
const FLOOR_MARK = 987654; // a value that must never appear in any dataset

let db: ReturnType<typeof installTestDb>["db"];
let demoSlug: string;
let a: { id: string; slug: string; cookie: string };
let b: { id: string; slug: string; cookie: string };

function workspaceWithShop(name: string) {
  const ws = resolveWorkspace(db, new Headers());
  const { shop } = createShop(db, ws.id, { name, source_url: null, products: [product] });
  db.prepare("UPDATE shops SET rules_json = ? WHERE id = ?").run(JSON.stringify({ floor_price_cents: FLOOR_MARK, cost_cents: FLOOR_MARK, min_margin: 0.3 }), shop.id);
  db.prepare("INSERT INTO orders (id, shop_id, status, amount_cents) VALUES (?, ?, 'PAID', 1234)").run(`ord_${name}`, shop.id);
  db.prepare("INSERT INTO search_log (shop_id, query, results_count, agent_id) VALUES (?, ?, 0, ?)").run(shop.id, `query of ${name}`, `agent-${name}`);
  return { id: ws.id, slug: shop.slug, cookie: `ql_ws=${ws.id}` };
}

const get = (table: string, shop: string | null, cookie?: string, ip = "9.9.9.9") =>
  GET(new Request(`${U}?table=${table}${shop ? `&shop=${shop}` : ""}`, { headers: { host: "localhost:3000", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) } }));

beforeEach(() => {
  vi.stubEnv("CHANNEL3_API_KEY", "");
  const s = installTestDb();
  db = s.db;
  demoSlug = s.shop.slug;
  seedDemoHistory(db, s.shop.id);
  a = workspaceWithShop("alpha");
  b = workspaceWithShop("bravo");
});

describe("/api/studio/data", () => {
  it("returns only the caller's own shop data, never another workspace's", async () => {
    const res = await get("orders", a.slug, a.cookie);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("ord_alpha");
    expect(text).not.toContain("ord_bravo");
    const searches = JSON.stringify(await (await get("searches", a.slug, a.cookie)).json());
    expect(searches).toContain("query of alpha");
    expect(searches).not.toContain("bravo");
  });

  it("answers 404 for a shop slug the workspace cannot see, and for no cookie asking for a private shop", async () => {
    expect((await get("orders", b.slug, a.cookie)).status).toBe(404);
    expect((await get("orders", a.slug)).status).toBe(404);
    expect((await get("orders", "no-such-shop", a.cookie)).status).toBe(404);
  });

  it("falls back to the demo shop (labelled Demo) for a visitor with no cookie", async () => {
    const body = (await (await get("orders", demoSlug)).json()) as { rows: { data_origin: string; order_id: string }[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((r) => r.data_origin === "Demo")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/ord_(alpha|bravo)/);
  });

  it("labels live rows Live and demo rows Demo", async () => {
    const body = (await (await get("orders", a.slug, a.cookie)).json()) as { rows: { data_origin: string }[] };
    expect(body.rows.map((r) => r.data_origin)).toEqual(["Live"]);
  });

  it("never exposes floor, cost or rules in any dataset, rows or field names", async () => {
    for (const slug of [a.slug, demoSlug]) {
      for (const table of STUDIO_TABLES) {
        const res = await get(table, slug, a.cookie, `1.1.1.${STUDIO_TABLES.indexOf(table)}`);
        const text = JSON.stringify(await res.json());
        expect(text, `${slug}/${table}`).not.toContain(String(FLOOR_MARK));
        expect(text, `${slug}/${table}`).not.toMatch(/floor|cost|rules|margin|signature|paypal/i);
      }
    }
    for (const fields of Object.values(STUDIO_FIELDS)) for (const f of fields) expect(`${f.id} ${f.name}`).not.toMatch(/floor|cost|rules|margin|signature|paypal/i);
  });

  it("rejects an unknown table, and rate limits per IP", async () => {
    expect((await get("shops", a.slug, a.cookie)).status).toBe(400);
    expect((await get("sqlite_master", a.slug, a.cookie)).status).toBe(400);
    let last = 200;
    for (let i = 0; i < 130; i++) last = (await get("orders", demoSlug, undefined, "7.7.7.7")).status;
    expect(last).toBe(429);
  });
});
