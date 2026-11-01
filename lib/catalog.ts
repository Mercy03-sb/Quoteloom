import type { DB } from "./db";
import { parseRules } from "./policy";

export type Shop = { id: number; slug: string; name: string; source_url: string | null };

export type ProductRow = {
  sku: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  stock: number;
  attrs_json: string;
};

export type ProductResult = {
  sku: string;
  title: string;
  description: string;
  price: string; // decimal major units, e.g. "48.00"
  price_cents: number;
  currency: string;
  in_stock: boolean;
};

export type SearchInput = { query: string; max_price?: number; limit?: number };

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export function getShop(db: DB, slug: string): Shop | undefined {
  return db.prepare("SELECT id, slug, name, source_url FROM shops WHERE slug = ?").get(slug) as Shop | undefined;
}

export function listProducts(db: DB, shopId: number): ProductRow[] {
  return db
    .prepare(
      "SELECT sku, title, description, price_cents, currency, stock, attrs_json FROM products WHERE shop_id = ? ORDER BY title",
    )
    .all(shopId) as ProductRow[];
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Lowercase word tokens; drops a trailing plural "s" so "towels" matches "towel". */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length >= 2)
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

function score(queryTokens: string[], p: ProductRow): number {
  const haystack = new Set(tokenize(`${p.sku} ${p.title} ${p.description} ${p.attrs_json}`));
  return queryTokens.reduce((n, t) => n + (haystack.has(t) ? 1 : 0), 0);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Keyword search over one shop's catalog. Every call is written to search_log
 * (feeds the unmet-demand view), including zero-result searches.
 */
export function searchProducts(db: DB, shop: Shop, input: SearchInput, agentId: string | null = null): ProductResult[] {
  const tokens = tokenize(input.query);
  const maxCents = input.max_price === undefined ? undefined : Math.round(input.max_price * 100);

  const ranked = listProducts(db, shop.id)
    .filter((p) => maxCents === undefined || p.price_cents <= maxCents)
    .map((p) => ({ p, s: tokens.length === 0 ? 1 : score(tokens, p) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || a.p.price_cents - b.p.price_cents)
    .slice(0, clampLimit(input.limit))
    .map(({ p }) => toResult(p));

  db.prepare("INSERT INTO search_log (shop_id, query, results_count, agent_id) VALUES (?, ?, ?, ?)").run(
    shop.id,
    input.query,
    ranked.length,
    agentId,
  );
  return ranked;
}

function toResult(p: ProductRow): ProductResult {
  return {
    sku: p.sku,
    title: p.title,
    description: p.description,
    price: formatCents(p.price_cents),
    price_cents: p.price_cents,
    currency: p.currency,
    in_stock: p.stock > 0,
  };
}

export type ProductDetail = ProductResult & {
  stock: number;
  attributes: Record<string, string | number>;
  quantity_discounts: { min_qty: number; discount_pct: number }[];
  negotiable: boolean;
};

/** Attribute keys that are the merchant's private numbers (cost, floor) and never leave the server. */
const PRIVATE_ATTR = /cost|floor|margin/i;

/** One product with public details only. Merchant cost and floor price are never included. */
export function getProduct(db: DB, shop: Shop, sku: string): ProductDetail | undefined {
  const row = db
    .prepare("SELECT sku, title, description, price_cents, currency, stock, attrs_json FROM products WHERE shop_id = ? AND sku = ?")
    .get(shop.id, sku) as ProductRow | undefined;
  if (!row) return undefined;
  const attributes: Record<string, string | number> = {};
  try {
    for (const [k, v] of Object.entries(JSON.parse(row.attrs_json || "{}") as Record<string, unknown>)) {
      if (!PRIVATE_ATTR.test(k) && (typeof v === "string" || typeof v === "number")) attributes[k] = v;
    }
  } catch {
    /* no attributes */
  }
  const rules = parseRules((db.prepare("SELECT rules_json FROM shops WHERE id = ?").get(shop.id) as { rules_json: string }).rules_json);
  return {
    ...toResult(row),
    stock: row.stock,
    attributes,
    quantity_discounts: rules.quantity_breaks,
    negotiable: rules.negotiation,
  };
}
