// Rule-based parser for messy HTML with no usable JSON-LD or Open Graph data.
// Deterministic and offline: it is the fallback when there is no Gemini key, or Gemini fails or is rate limited.
import { DEFAULT_STOCK, parsePriceToCents, skuFromTitle, type DraftProduct } from "./draft";
import { attrsOf, decodeEntities, metaTags, pageTitle, squash, stripNonContent, textOf } from "./html";

const CURRENCY_BY_SYMBOL: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "rs": "INR", "rs.": "INR" };
// A price needs a currency marker, so "6 pack" or "180 x 30 cm" is never read as a price.
const PRICE_RE = /(?:(USD|EUR|GBP|INR|CAD|AUD)\s?|(\$|€|£|₹|Rs\.?)\s?)(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d+(?:\.\d{2}))\s?(USD|EUR|GBP|INR|CAD|AUD)\b/i;

export function findPrice(s: string): { cents: number; currency: string } | null {
  const m = PRICE_RE.exec(s);
  if (!m) return null;
  const cents = parsePriceToCents(m[3] ?? m[4]);
  if (cents === null || cents === 0) return null;
  const sym = (m[2] ?? "").toLowerCase();
  return { cents, currency: (m[1] ?? m[5] ?? CURRENCY_BY_SYMBOL[sym] ?? "USD").toUpperCase() };
}

const OPEN_TAG = /<(?:li|article|div|section|tr)\b[^>]*>/gi;
const CARD_WORD = /product|item|card|listing|sku/;
// Parts of a card (title, price, image...) and page furniture (list, filter...) are not card starts.
const NOT_A_CARD = /title|name|price|image|img|desc|info|link|badge|label|thumb|action|meta|list|grid|wrap|container|gallery|detail|count|sort|filter|categor|nav|menu|rating|review/;

function cardStarts(html: string): number[] {
  const out: number[] = [];
  for (const m of html.matchAll(OPEN_TAG)) {
    const a = attrsOf(m[0]);
    const tokens = `${a.class ?? ""} ${a.id ?? ""}`.toLowerCase().split(/\s+/);
    if (tokens.some((t) => CARD_WORD.test(t) && !NOT_A_CARD.test(t))) out.push(m.index as number);
  }
  return out;
}

function titleOfBlock(block: string): string {
  const h = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/i.exec(block);
  if (h) {
    const t = textOf(h[1]);
    if (t) return t;
  }
  for (const a of block.matchAll(/<a\b[^>]*>/gi)) {
    const t = attrsOf(a[0]).title;
    if (t) return squash(t);
  }
  const img = /<img\b[^>]*>/i.exec(block);
  return img ? squash(attrsOf(img[0]).alt ?? "") : "";
}

function descriptionOfBlock(block: string, title: string): string {
  for (const p of block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const t = textOf(p[1]);
    if (t && t !== title && !PRICE_RE.test(t) && t.length > 15) return t.slice(0, 1000);
  }
  return "";
}

/** Product cards: split at each product-looking container, keep slices that have a title and a price. */
function fromCards(html: string): DraftProduct[] {
  const starts = cardStarts(html);
  const out: DraftProduct[] = [];
  const seen = new Set<string>();
  starts.forEach((start, i) => {
    const block = html.slice(start, Math.min(starts[i + 1] ?? html.length, start + 4000));
    const title = titleOfBlock(block);
    const price = findPrice(textOf(block));
    if (!title || !price || title.length > 200) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const idAttr = attrsOf(/^<[^>]+>/.exec(block)?.[0] ?? "");
    const sku = (idAttr["data-sku"] ?? idAttr["data-id"] ?? "").trim() || skuFromTitle(title);
    out.push({
      sku,
      title,
      description: descriptionOfBlock(block, title),
      price_cents: price.cents,
      currency: price.currency,
      stock: /sold out|out of stock/i.test(textOf(block)) ? 0 : DEFAULT_STOCK,
    });
  });
  return out;
}

/** A single product page: one h1 plus the first price on the page. */
function fromSinglePage(html: string): DraftProduct[] {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const title = h1 ? textOf(h1[1]) : "";
  if (!title) return [];
  const price = findPrice(textOf(html));
  if (!price) return [];
  const meta = metaTags(html);
  return [
    {
      sku: skuFromTitle(title),
      title: title.slice(0, 200),
      description: squash(decodeEntities(meta.description ?? meta["og:description"] ?? "")).slice(0, 1000) || (pageTitle(html) ?? ""),
      price_cents: price.cents,
      currency: price.currency,
      stock: /sold out|out of stock/i.test(textOf(html)) ? 0 : DEFAULT_STOCK,
    },
  ];
}

export function parseRuleBased(rawHtml: string): DraftProduct[] {
  const html = stripNonContent(rawHtml);
  const cards = fromCards(html);
  return cards.length ? cards : fromSinglePage(html);
}
