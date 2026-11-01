// Creating shops from a reviewed draft. The draft is re-validated here because the browser edited it.
import type { Shop } from "./catalog";
import type { DB } from "./db";
import { cleanDraft } from "./ingest/draft";
import { validateRules, type ShopRules } from "./policy";
import { DEMO_SHOP } from "./seed-data";

export const MAX_SHOPS_PER_WORKSPACE = 5;
export const MAX_SHOPS_TOTAL = 200;
const RESERVED = new Set([DEMO_SHOP.slug, "api", "demo-shops", "new"]);

export class ShopError extends Error {
  constructor(
    public code: "too_many_shops" | "server_full" | "invalid_draft" | "invalid_name" | "invalid_rules" | "not_found" | "read_only",
    message: string,
  ) {
    super(message);
  }
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "shop";
}

function uniqueSlug(db: DB, base: string): string {
  let slug = base;
  for (let i = 2; RESERVED.has(slug) || db.prepare("SELECT 1 FROM shops WHERE slug = ?").get(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export type NewShop = { name: string; source_url: string | null; products: unknown[] };

export function createShop(db: DB, workspaceId: string, input: NewShop): { shop: Shop; products: number } {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ShopError("invalid_name", "Give the shop a name.");
  const { rows, errors } = cleanDraft(input.products);
  if (errors.length) throw new ShopError("invalid_draft", errors[0]);
  if (rows.length === 0) throw new ShopError("invalid_draft", "Add at least one product before publishing.");

  const tx = db.transaction((): { shop: Shop; products: number } => {
    const own = (db.prepare("SELECT COUNT(*) AS n FROM shops WHERE workspace_id = ?").get(workspaceId) as { n: number }).n;
    if (own >= MAX_SHOPS_PER_WORKSPACE) {
      throw new ShopError("too_many_shops", `A workspace can hold ${MAX_SHOPS_PER_WORKSPACE} shops. This is a demo.`);
    }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM shops").get() as { n: number }).n;
    if (total >= MAX_SHOPS_TOTAL) throw new ShopError("server_full", "The demo server is full. It resets on restart.");

    const slug = uniqueSlug(db, slugify(name));
    // New shops start with list price only; the owner turns negotiation on in Settings.
    const rules = { min_margin_pct: DEMO_SHOP.rules.min_margin_pct, max_discount_pct: DEMO_SHOP.rules.max_discount_pct, negotiation: false, max_qty: DEMO_SHOP.rules.max_qty, quantity_breaks: [] };
    const info = db
      .prepare("INSERT INTO shops (slug, name, source_url, rules_json, workspace_id) VALUES (?, ?, ?, ?, ?)")
      .run(slug, name, input.source_url, JSON.stringify(rules), workspaceId);
    const ins = db.prepare(
      `INSERT INTO products (shop_id, sku, title, description, price_cents, currency, stock, attrs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    );
    for (const p of rows) ins.run(info.lastInsertRowid, p.sku, p.title, p.description, p.price_cents, p.currency, p.stock);
    db.prepare("INSERT INTO events (type, payload_json) VALUES ('shop.published', ?)").run(JSON.stringify({ slug, products: rows.length }));
    return { shop: { id: Number(info.lastInsertRowid), slug, name, source_url: input.source_url }, products: rows.length };
  });
  return tx();
}

/** Save validated rules for a shop the workspace owns. The shared demo shop is read-only. */
export function updateShopRules(db: DB, workspaceId: string | null, slug: string, input: unknown): ShopRules {
  const check = validateRules(input);
  if (!check.ok) throw new ShopError("invalid_rules", check.error);
  const row = db.prepare("SELECT id, workspace_id FROM shops WHERE slug = ?").get(slug) as { id: number; workspace_id: string | null } | undefined;
  if (!row || (row.workspace_id !== null && row.workspace_id !== workspaceId)) throw new ShopError("not_found", "No such shop.");
  if (row.workspace_id === null) throw new ShopError("read_only", "The shared demo shop is read-only. Publish your own shop to edit its rules.");
  db.prepare("UPDATE shops SET rules_json = ? WHERE id = ?").run(JSON.stringify(check.rules), row.id);
  db.prepare("INSERT INTO events (type, payload_json) VALUES ('shop.rules', ?)").run(JSON.stringify({ slug }));
  return check.rules;
}
