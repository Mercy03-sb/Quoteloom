// URL ingest: fetch -> discover product pages -> extract (JSON-LD, Open Graph) -> LLM fallback -> rules fallback -> draft.
import type { DB } from "../db";
import { renderDemoShopPage } from "../demo-shops";
import { describeFailure } from "../llm";
import { MAX_PRODUCTS, skuFromTitle, type DraftProduct } from "./draft";
import { extractStructured, shopNameFrom } from "./extract";
import { sameOriginLinks } from "./html";
import { normaliseWithLlm } from "./normalise";
import { parseRuleBased } from "./rules";
import { FetchError, parseSafeUrl, safeFetchText, type FetchedText, type SafeFetchOptions } from "./safe-fetch";

export const MAX_LINKED_PAGES = 20;
const MAX_LLM_PAGES = 3;
const CONCURRENCY = 4;

export type StepId = "validate" | "fetch" | "discover" | "pages" | "extract" | "draft";
export type StepEvent = { id: StepId; label: string; status: "running" | "done" | "warn" | "error"; detail?: string };

export type IngestResult = {
  shopName: string;
  sourceUrl: string;
  products: DraftProduct[];
  methods: { jsonld: number; opengraph: number; llm: number; rules: number };
  warnings: string[];
};

export type PageFetcher = (url: string) => Promise<FetchedText>;

/** Fetcher that serves this app's own /demo-shops pages in-process (so they work on localhost) and everything else via safeFetchText. */
export function makeFetcher(selfOrigin: string | null, opts: SafeFetchOptions = {}): PageFetcher {
  return async (url) => {
    if (isSelfDemoUrl(url, selfOrigin)) {
      const u = new URL(url);
      const html = renderDemoShopPage(u.pathname);
      if (html === null) throw new FetchError("bad_status", "The site answered with HTTP 404.");
      return { url: u.href, status: 200, contentType: "text/html", text: html };
    }
    return safeFetchText(url, opts);
  };
}

/** Only this app's own static demo pages are served in-process; no other URL ever skips the SSRF checks. */
export function isSelfDemoUrl(url: string, selfOrigin: string | null): boolean {
  try {
    const u = new URL(url);
    return Boolean(selfOrigin) && u.origin === selfOrigin && (u.pathname === "/demo-shops" || u.pathname.startsWith("/demo-shops/"));
  } catch {
    return false;
  }
}

const SKIP_PATH = /\/(cart|basket|login|signin|sign-in|register|account|checkout|privacy|terms|policies|contact|about|blog|faq|search|wishlist)(\/|$)/i;
const PRODUCT_HINT = /product|item|shop|catalog|collection|store|\/p\//i;

export function pickProductLinks(links: string[], mainUrl: string, limit = MAX_LINKED_PAGES): string[] {
  const main = new URL(mainUrl);
  main.hash = "";
  return links
    .filter((l) => l !== main.href && !SKIP_PATH.test(new URL(l).pathname))
    .map((l, i) => ({ l, i, score: PRODUCT_HINT.test(new URL(l).pathname) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.l);
}

async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const better = (a: DraftProduct, b: DraftProduct) =>
  a.price_cents > 0 !== b.price_cents > 0 ? (a.price_cents > 0 ? a : b) : b.description.length > a.description.length ? b : a;

/** Merge duplicates by title (a product often appears on a listing and on its own page), make SKUs unique, cap the count. */
export function finalizeDraft(products: DraftProduct[]): DraftProduct[] {
  const byTitle = new Map<string, DraftProduct>();
  for (const p of products) {
    const key = p.title.toLowerCase();
    const prev = byTitle.get(key);
    byTitle.set(key, prev ? better(prev, p) : p);
  }
  const used = new Set<string>();
  const out: DraftProduct[] = [];
  for (const p of byTitle.values()) {
    let sku = p.sku.trim().toUpperCase().replace(/[^A-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || skuFromTitle(p.title);
    const base = sku;
    for (let n = 2; used.has(sku); n++) sku = `${base}-${n}`;
    used.add(sku);
    out.push({ ...p, sku });
  }
  return out.slice(0, MAX_PRODUCTS);
}

export type IngestOptions = {
  fetchPage: PageFetcher;
  /** This app's own origin, so its /demo-shops pages can be ingested without a network hop. */
  selfOrigin?: string | null;
  onStep?: (e: StepEvent) => void;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

export async function ingestUrl(db: DB, rawUrl: string, o: IngestOptions): Promise<IngestResult> {
  const emit = (e: StepEvent) => o.onStep?.(e);
  const warnings: string[] = [];
  const methods = { jsonld: 0, opengraph: 0, llm: 0, rules: 0 };
  type Method = keyof typeof methods;
  const methodOf = new Map<string, Method>(); // by lower-case title, first sighting wins; counted after de-duplication
  const tag = (list: DraftProduct[], m: Method) => list.forEach((p) => methodOf.has(p.title.toLowerCase()) || methodOf.set(p.title.toLowerCase(), m));

  emit({ id: "validate", label: "Checking the address", status: "running" });
  const url = isSelfDemoUrl(rawUrl, o.selfOrigin ?? null) ? new URL(rawUrl) : parseSafeUrl(rawUrl);
  emit({ id: "validate", label: "Checking the address", status: "done", detail: url.host });

  emit({ id: "fetch", label: "Fetching the page", status: "running" });
  const main = await o.fetchPage(url.href);
  emit({ id: "fetch", label: "Fetching the page", status: "done", detail: `${Math.round(main.text.length / 1000)} KB` });

  emit({ id: "discover", label: "Finding product pages", status: "running" });
  const base = new URL(main.url);
  const first = extractStructured(main.text);
  const linkPool = [...first.itemUrls.flatMap((u) => safeSameOrigin(u, base)), ...sameOriginLinks(main.text, base)];
  const links = pickProductLinks([...new Set(linkPool)], main.url);
  emit({ id: "discover", label: "Finding product pages", status: "done", detail: `${links.length} linked page${links.length === 1 ? "" : "s"}` });

  emit({ id: "pages", label: "Reading product pages", status: "running", detail: links.length ? `0 of ${links.length}` : "none to read" });
  let fetched = 0;
  const pages = await mapLimit(links, CONCURRENCY, async (l) => {
    try {
      return await o.fetchPage(l);
    } catch (e) {
      warnings.push(`Skipped ${l}: ${(e as Error).message}`);
      return null;
    } finally {
      fetched++;
      emit({ id: "pages", label: "Reading product pages", status: "running", detail: `${fetched} of ${links.length}` });
    }
  });
  const okPages = pages.filter((p): p is FetchedText => p !== null);
  emit({ id: "pages", label: "Reading product pages", status: okPages.length === links.length ? "done" : "warn", detail: `${okPages.length} read` });

  emit({ id: "extract", label: "Extracting products", status: "running" });
  const all = [main, ...okPages];
  const found: DraftProduct[] = [];
  const bare: FetchedText[] = []; // pages with no structured data
  for (const [i, page] of all.entries()) {
    const ex = i === 0 ? first : extractStructured(page.text);
    if (ex.products.length === 0) bare.push(page);
    else {
      tag(ex.products, ex.method === "jsonld" ? "jsonld" : "opengraph");
      found.push(...ex.products);
    }
  }

  if (found.length === 0) {
    // Structured data wins when it exists anywhere. Only a site with none falls back to the LLM, then to rules.
    let llmCalls = 0;
    let llmNote: string | null = null;
    for (const page of bare) {
      let got: DraftProduct[] = [];
      if (llmCalls < MAX_LLM_PAGES) {
        llmCalls++;
        const r = await normaliseWithLlm(db, page.text, { env: o.env, fetchImpl: o.fetchImpl });
        got = r.products;
        if (got.length) tag(got, "llm");
        else if (!r.llm.ok && r.llm.reason !== "no_key" && !(r.llm.reason === "empty" && !r.llm.detail)) llmNote = `${describeFailure(r.llm)}; used the rule-based parser.`;
      }
      if (got.length === 0) {
        got = parseRuleBased(page.text);
        tag(got, "rules");
      }
      found.push(...got);
    }
    if (llmNote) warnings.push(llmNote);
  }
  const products = finalizeDraft(found);
  for (const p of products) methods[methodOf.get(p.title.toLowerCase()) ?? "rules"]++;
  const how = (Object.entries(methods) as [string, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${n} via ${k}`).join(", ");
  emit({ id: "extract", label: "Extracting products", status: found.length ? "done" : "warn", detail: how || "nothing found" });

  emit({ id: "draft", label: "Building the draft catalog", status: "running" });
  const noPrice = products.filter((p) => p.price_cents === 0).length;
  if (noPrice) warnings.push(`${noPrice} product${noPrice === 1 ? " has" : "s have"} no price. Fix them in the table before publishing.`);
  if (products.length === 0) warnings.push("No products were found on that site. Try a product listing page, or upload a CSV.");
  emit({ id: "draft", label: "Building the draft catalog", status: products.length ? "done" : "warn", detail: `${products.length} product${products.length === 1 ? "" : "s"}` });

  return { shopName: shopNameFrom(main.text, base.hostname), sourceUrl: main.url, products, methods, warnings };
}

function safeSameOrigin(u: string, base: URL): string[] {
  try {
    const x = new URL(u, base);
    x.hash = "";
    return x.origin === base.origin ? [x.href] : [];
  } catch {
    return [];
  }
}

