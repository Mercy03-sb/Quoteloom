// The draft catalog: what ingest produces and what the merchant edits before publishing.
// cleanDraft is the single validator, used for ingest output and again on publish (the browser edited it).

export type DraftProduct = {
  sku: string;
  title: string;
  description: string;
  price_cents: number; // 0 means "price not found, fix it"; cleanDraft rejects 0 on publish
  currency: string;
  stock: number;
};

export const MAX_PRODUCTS = 200;
export const MAX_PRICE_CENTS = 10_000_000; // $100,000
export const DEFAULT_STOCK = 10; // ingested pages rarely expose stock; editable in the grid

/** "Merino Scarf, Grey!" -> "MERINO-SCARF-GREY" */
export function skuFromTitle(title: string): string {
  return (
    title
      .toUpperCase()
      .normalize("NFKD")
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "ITEM"
  );
}

/** Parse "12.50", "$1,299", "12,50" (decimal comma) or 12.5 into integer cents. Null when not a price. */
export function parsePriceToCents(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  if (typeof input !== "string") return null;
  let s = input.replace(/[^\d.,]/g, "").replace(/^[.,]+|[.,]+$/g, ""); // "Rs. 450" leaves a stray dot
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // "12,50" is a decimal comma only when exactly 1-2 digits follow; otherwise commas are thousands separators.
    s = s.length - lastComma - 1 <= 2 ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export function normaliseSku(raw: unknown, title: string): string {
  const s = typeof raw === "string" ? raw.trim().slice(0, 64).toUpperCase().replace(/[^A-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  return s || skuFromTitle(title);
}

export type ProblemField = "title" | "sku" | "price" | "currency" | "stock";

/**
 * Per-row problems for the review grid, keyed by row id. Mirrors cleanDraft so the Publish button
 * is only enabled when the server will accept the draft.
 */
export function findProblems(rows: (Partial<DraftProduct> & { _id: string })[]): Record<string, ProblemField[]> {
  const out: Record<string, ProblemField[]> = {};
  const count = new Map<string, number>();
  const skuOf = (r: Partial<DraftProduct>) => normaliseSku(r.sku, r.title ?? "");
  for (const r of rows) if ((r.title ?? "").trim()) count.set(skuOf(r), (count.get(skuOf(r)) ?? 0) + 1);
  for (const r of rows) {
    const bad: ProblemField[] = [];
    if (!(r.title ?? "").trim()) bad.push("title");
    else if ((count.get(skuOf(r)) ?? 0) > 1) bad.push("sku");
    const p = r.price_cents;
    if (typeof p !== "number" || !Number.isInteger(p) || p <= 0 || p > MAX_PRICE_CENTS) bad.push("price");
    if (!/^[A-Za-z]{3}$/.test((r.currency ?? "USD").trim() || "USD")) bad.push("currency");
    const st = r.stock;
    if (st !== undefined && (typeof st !== "number" || !Number.isInteger(st) || st < 0 || st > 100_000)) bad.push("stock");
    if (bad.length) out[r._id] = bad;
  }
  return out;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * Validate and normalise rows. Returns clean rows plus human-readable errors; callers reject if errors exist.
 * Duplicate SKUs and zero or missing prices are errors, not silently fixed.
 */
export function cleanDraft(input: unknown[]): { rows: DraftProduct[]; errors: string[] } {
  const rows: DraftProduct[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  input.slice(0, MAX_PRODUCTS + 1).forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object") return void errors.push(`Row ${n}: not a product.`);
    const r = raw as Record<string, unknown>;
    const title = str(r.title, 200);
    if (!title) return void errors.push(`Row ${n}: title is required.`);
    const sku = normaliseSku(r.sku, title);
    if (seen.has(sku)) return void errors.push(`Row ${n}: duplicate SKU ${sku}.`);
    const price = r.price_cents;
    if (typeof price !== "number" || !Number.isInteger(price) || price <= 0 || price > MAX_PRICE_CENTS) {
      return void errors.push(`Row ${n} (${sku}): enter a price between 0.01 and ${MAX_PRICE_CENTS / 100}.`);
    }
    const currency = str(r.currency, 8).toUpperCase() || "USD";
    if (!/^[A-Z]{3}$/.test(currency)) return void errors.push(`Row ${n} (${sku}): currency must be a 3-letter code.`);
    const stock = r.stock === undefined || r.stock === null ? DEFAULT_STOCK : r.stock;
    if (typeof stock !== "number" || !Number.isInteger(stock) || stock < 0 || stock > 100_000) {
      return void errors.push(`Row ${n} (${sku}): stock must be a whole number from 0 to 100000.`);
    }
    seen.add(sku);
    rows.push({ sku, title, description: str(r.description, 1000), price_cents: price, currency, stock });
  });
  if (input.length > MAX_PRODUCTS) errors.push(`At most ${MAX_PRODUCTS} products per shop.`);
  return { rows, errors };
}
