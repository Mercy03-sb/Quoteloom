// Structured extraction: JSON-LD first, Open Graph second. No LLM involved.
import { DEFAULT_STOCK, parsePriceToCents, skuFromTitle, type DraftProduct } from "./draft";
import { decodeEntities, metaTags, pageTitle, squash } from "./html";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = <T,>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const raw = m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim();
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* tolerate broken JSON-LD: the rest of the page may still work */
    }
  }
  return out;
}

const hasType = (n: Json, t: string) => asArray(n["@type"] as string | string[] | undefined).some((x) => typeof x === "string" && x.toLowerCase() === t.toLowerCase());
const text = (v: unknown): string => (typeof v === "string" ? squash(decodeEntities(v)) : typeof v === "number" ? String(v) : "");

function offerOf(p: Json): { price: number | null; currency: string; stock: number } {
  let price: number | null = null;
  let currency = "";
  let stock = DEFAULT_STOCK;
  for (const o of asArray(p.offers as unknown)) {
    if (!isObj(o)) continue;
    const spec = isObj(o.priceSpecification) ? o.priceSpecification : {};
    const raw = o.price ?? o.lowPrice ?? spec.price;
    const cents = parsePriceToCents(typeof raw === "string" || typeof raw === "number" ? raw : undefined);
    if (price === null && cents !== null) {
      price = cents;
      currency = text(o.priceCurrency ?? spec.priceCurrency).toUpperCase();
    }
    const avail = text(o.availability).toLowerCase();
    if (/outofstock|soldout|discontinued/.test(avail)) stock = 0;
    const level = isObj(o.inventoryLevel) ? Number(o.inventoryLevel.value) : NaN;
    if (Number.isInteger(level) && level >= 0) stock = level;
  }
  return { price, currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD", stock };
}

function productFromNode(n: Json, inherit?: Json): DraftProduct | null {
  const name = text(n.name ?? inherit?.name);
  if (!name) return null;
  const offer = offerOf(n.offers ? n : (inherit ?? n));
  const sku = text(n.sku ?? n.productID ?? n.mpn ?? n.gtin13 ?? n.gtin) || skuFromTitle(name);
  return {
    sku,
    title: name.slice(0, 200),
    description: text(n.description ?? inherit?.description).slice(0, 1000),
    price_cents: offer.price ?? 0,
    currency: offer.currency,
    stock: offer.stock,
  };
}

function walk(node: unknown, out: DraftProduct[], urls: string[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, out, urls, depth + 1));
  if (!isObj(node)) return;
  if (hasType(node, "ProductGroup")) {
    const variants = asArray(node.hasVariant as unknown).filter(isObj);
    if (variants.length) variants.forEach((v) => { const p = productFromNode(v, node); if (p) out.push(p); });
    else { const p = productFromNode(node); if (p) out.push(p); }
    return;
  }
  if (hasType(node, "Product")) {
    const p = productFromNode(node);
    if (p) out.push(p);
    return;
  }
  if (hasType(node, "ItemList")) {
    for (const el of asArray(node.itemListElement as unknown)) {
      if (isObj(el) && typeof el.url === "string" && !el.item) urls.push(el.url);
      walk(isObj(el) && el.item ? el.item : el, out, urls, depth + 1);
    }
    return;
  }
  for (const v of Object.values(node)) if (typeof v === "object") walk(v, out, urls, depth + 1);
}

export function productsFromJsonLd(blocks: unknown[]): { products: DraftProduct[]; urls: string[] } {
  const products: DraftProduct[] = [];
  const urls: string[] = [];
  walk(blocks, products, urls);
  return { products, urls };
}

/** A single product described by Open Graph / product: meta tags, e.g. a product detail page without JSON-LD. */
export function productFromOpenGraph(html: string): DraftProduct | null {
  const m = metaTags(html);
  const isProduct = /product/i.test(m["og:type"] ?? "") || m["product:price:amount"] !== undefined || m["og:price:amount"] !== undefined;
  if (!isProduct) return null;
  const title = squash(decodeEntities(m["og:title"] ?? pageTitle(html) ?? ""));
  if (!title) return null;
  const cents = parsePriceToCents(m["product:price:amount"] ?? m["og:price:amount"] ?? m["twitter:data1"]);
  const cur = (m["product:price:currency"] ?? m["og:price:currency"] ?? "USD").toUpperCase();
  return {
    sku: skuFromTitle(title),
    title: title.slice(0, 200),
    description: squash(decodeEntities(m["og:description"] ?? m.description ?? "")).slice(0, 1000),
    price_cents: cents ?? 0,
    currency: /^[A-Z]{3}$/.test(cur) ? cur : "USD",
    stock: /out of stock|oos/i.test(m["product:availability"] ?? m["og:availability"] ?? "") ? 0 : DEFAULT_STOCK,
  };
}

export type PageExtraction = { products: DraftProduct[]; method: "jsonld" | "opengraph" | "none"; itemUrls: string[] };

/** JSON-LD first, Open Graph if that found nothing. */
export function extractStructured(html: string): PageExtraction {
  const { products, urls } = productsFromJsonLd(extractJsonLdBlocks(html));
  if (products.length) return { products, method: "jsonld", itemUrls: urls };
  const og = productFromOpenGraph(html);
  if (og) return { products: [og], method: "opengraph", itemUrls: urls };
  return { products: [], method: "none", itemUrls: urls };
}

/** The fake demo stores add "(fake demo store)" to their page titles; it should not end up in a shop name. */
const DEMO_SUFFIX = /\s*\((?:fake )?demo(?: store)?\)\s*$/i;

/** Best guess at the shop's name for the Setup form. */
export function shopNameFrom(html: string, host: string): string {
  const m = metaTags(html);
  const raw = m["og:site_name"] ?? pageTitle(html) ?? host;
  const name = squash(decodeEntities(raw)).split(/\s[|–—-]\s/)[0].replace(DEMO_SUFFIX, "").trim();
  return name.slice(0, 80) || host;
}
