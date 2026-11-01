// CSV upload -> draft products. Hand-written parser (quotes, escaped quotes, CRLF, BOM); no dependency.
import { DEFAULT_STOCK, MAX_PRODUCTS, parsePriceToCents, skuFromTitle, type DraftProduct } from "./draft";

export const MAX_CSV_BYTES = 1_000_000;

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  sku: ["sku", "id", "product_id", "handle", "code", "item_code"],
  title: ["title", "name", "product", "product_name", "product_title"],
  description: ["description", "desc", "body", "details"],
  price: ["price", "unit_price", "price_usd", "amount", "cost_to_buyer"],
  price_cents: ["price_cents", "cents"],
  currency: ["currency", "currency_code"],
  stock: ["stock", "quantity", "qty", "inventory", "on_hand"],
};

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export type CsvResult = { products: DraftProduct[]; warnings: string[]; error?: string };

export function draftFromCsv(text: string): CsvResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { products: [], warnings: [], error: "The CSV needs a header row and at least one product row." };
  const header = rows[0].map(norm);
  const col = (key: string) => header.findIndex((h) => ALIASES[key].includes(h));
  const idx = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, col(k)])) as Record<string, number>;
  if (idx.title < 0) {
    return { products: [], warnings: [], error: "No title column found. Use a header such as: sku,title,description,price,currency,stock." };
  }
  if (idx.price < 0 && idx.price_cents < 0) {
    return { products: [], warnings: [], error: "No price column found. Add a column named price." };
  }

  const warnings: string[] = [];
  const products: DraftProduct[] = [];
  const get = (r: string[], k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? "").trim() : "");
  for (const [i, r] of rows.slice(1).entries()) {
    if (products.length >= MAX_PRODUCTS) {
      warnings.push(`Only the first ${MAX_PRODUCTS} rows were read.`);
      break;
    }
    const title = get(r, "title");
    if (!title) {
      warnings.push(`Row ${i + 2}: no title, skipped.`);
      continue;
    }
    const cents = idx.price_cents >= 0 && get(r, "price_cents") ? Number(get(r, "price_cents")) : parsePriceToCents(get(r, "price"));
    if (cents === null || !Number.isInteger(cents)) warnings.push(`Row ${i + 2} (${title}): price not understood, set to 0. Fix it in the table.`);
    const stockRaw = get(r, "stock");
    const stock = stockRaw === "" ? DEFAULT_STOCK : Number(stockRaw);
    products.push({
      sku: get(r, "sku") || skuFromTitle(title),
      title: title.slice(0, 200),
      description: get(r, "description").slice(0, 1000),
      price_cents: cents !== null && Number.isInteger(cents) && cents > 0 ? cents : 0,
      currency: (get(r, "currency") || "USD").toUpperCase().slice(0, 3),
      stock: Number.isInteger(stock) && stock >= 0 ? stock : DEFAULT_STOCK,
    });
  }
  if (products.length === 0) return { products, warnings, error: "No usable product rows were found." };
  return { products, warnings };
}
