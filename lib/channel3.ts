// Channel3 product search client (plain fetch). See docs/channel3-notes.md.
// Order of use: SQLite cache, then ONE live call (short timeout, no retries), then the snapshot file, then nothing.
// Channel3 results are information only. They never set a price.
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { limiter } from "./ratelimit";

export const CHANNEL3_URL = "https://api.trychannel3.com/v1/search";
export const LIVE_TIMEOUT_MS = 4000;
export const CACHE_TTL_MS = 7 * 24 * 3600_000;
export const RESULT_LIMIT = 6;
const COOLDOWN_MS = 10 * 60_000; // after a 429 or 401 we stop calling for a while

export type C3Source = "live" | "cached" | "snapshot" | "none";

/** One similar item, reduced from a Channel3 product to its best offer. */
export type C3Product = {
  title: string;
  image: string | null;
  retailer: string;
  price: number;
  currency: string;
  in_stock: boolean;
  url: string; // affiliate redirect: merchant side only, never in buyer-facing negotiation
};

export type C3Lookup = { query: string; source: C3Source; products: C3Product[] };
export type C3Snapshot = { generated_at: string; entries: Record<string, C3Product[]> };

export const normaliseQuery = (q: string): string =>
  q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);

type RawOffer = { url?: string; domain?: string; price?: { price?: number; currency?: string }; availability?: string };
type RawProduct = { title?: string; images?: { url?: string; cleaned_url?: string | null }[]; offers?: RawOffer[] };

/** Reduce a raw Channel3 response to the fields we use. Cheapest in-stock offer per product, else the first offer. */
export function reduceProducts(raw: unknown): C3Product[] {
  const list = (raw as { products?: RawProduct[] } | null)?.products;
  if (!Array.isArray(list)) return [];
  const out: C3Product[] = [];
  for (const p of list) {
    const offers = (p.offers ?? []).filter((o) => typeof o?.price?.price === "number" && o.url && o.domain);
    if (!p.title || offers.length === 0) continue;
    const inStock = offers.filter((o) => o.availability === "InStock").sort((a, b) => a.price!.price! - b.price!.price!);
    const o = inStock[0] ?? offers[0];
    const img = p.images?.[0];
    out.push({
      title: p.title,
      image: img?.cleaned_url ?? img?.url ?? null,
      retailer: o.domain!,
      price: o.price!.price!,
      currency: (o.price!.currency ?? "USD").toUpperCase(),
      in_stock: o.availability === "InStock",
      url: o.url!,
    });
  }
  return out;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export class Channel3Error extends Error {
  constructor(
    public status: number | null,
    msg: string,
  ) {
    super(msg);
  }
}

/** One live call. Throws Channel3Error; its message never includes the key. */
export async function fetchLive(query: string, key: string, fetchImpl: FetchLike = fetch, timeoutMs = LIVE_TIMEOUT_MS): Promise<C3Product[]> {
  let res: Response;
  try {
    res = await fetchImpl(CHANNEL3_URL, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ query, limit: RESULT_LIMIT }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Channel3Error(null, "network error or timeout");
  }
  if (!res.ok) throw new Channel3Error(res.status, `HTTP ${res.status}`);
  try {
    return reduceProducts(await res.json());
  } catch {
    throw new Channel3Error(res.status, "unreadable response");
  }
}

// ---- snapshot ----
export const snapshotPath = (): string => path.join(process.cwd(), "data", "channel3-snapshot.json");
let snapshotMemo: { file: string; snap: C3Snapshot | null } | null = null;

export function loadSnapshot(file = snapshotPath()): C3Snapshot | null {
  if (snapshotMemo?.file === file) return snapshotMemo.snap;
  let snap: C3Snapshot | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as C3Snapshot;
    if (j && typeof j.entries === "object") snap = j;
  } catch {
    snap = null; // missing or unreadable: no snapshot, not an error
  }
  snapshotMemo = { file, snap };
  return snap;
}

// ---- cache ----
function readCache(db: DB, key: string, now: number): C3Product[] | null {
  const row = db.prepare("SELECT products_json, fetched_at FROM channel3_cache WHERE query = ?").get(key) as
    | { products_json: string; fetched_at: number }
    | undefined;
  if (!row || now - row.fetched_at > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.products_json) as C3Product[];
  } catch {
    return null;
  }
}
function writeCache(db: DB, key: string, products: C3Product[], now: number): void {
  db.prepare("INSERT OR REPLACE INTO channel3_cache (query, products_json, fetched_at) VALUES (?, ?, ?)").run(key, JSON.stringify(products), now);
}

// ---- lookup ----
export type LookupCtx = {
  ip?: string;
  workspace?: string | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: number;
  snapshotFile?: string;
  timeoutMs?: number;
};

const g = globalThis as unknown as { __c3Cooldown?: number; __c3Inflight?: Map<string, Promise<C3Product[] | null>> };

export const resetChannel3State = (): void => {
  g.__c3Cooldown = 0;
  g.__c3Inflight?.clear();
  snapshotMemo = null;
};

async function tryLive(db: DB, key: string, ctx: LookupCtx, now: number): Promise<C3Product[] | null> {
  const apiKey = (ctx.env ?? process.env).CHANNEL3_API_KEY;
  if (!apiKey) return null;
  if (now < (g.__c3Cooldown ?? 0)) return null;
  const ids = { workspace: ctx.workspace ?? null, ip: ctx.ip ?? "unknown" };
  if (!limiter().check("channel3", ids, now).ok) return null;
  if (!limiter().check("channel3_all", { workspace: "all", ip: "all" }, now).ok) return null;
  const inflight = (g.__c3Inflight ??= new Map());
  let p = inflight.get(key);
  if (!p) {
    p = fetchLive(key, apiKey, ctx.fetchImpl, ctx.timeoutMs)
      .then((products) => {
        writeCache(db, key, products, now);
        return products;
      })
      .catch((e: unknown) => {
        if (e instanceof Channel3Error && (e.status === 429 || e.status === 401 || e.status === 403)) g.__c3Cooldown = now + COOLDOWN_MS;
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Cache, then live, then snapshot, then nothing. Never throws. */
export async function lookupChannel3(db: DB, query: string, ctx: LookupCtx = {}): Promise<C3Lookup> {
  const key = normaliseQuery(query);
  if (!key) return { query: key, source: "none", products: [] };
  const now = ctx.now ?? Date.now();
  try {
    const cached = readCache(db, key, now);
    if (cached) return { query: key, source: "cached", products: cached };
    const live = await tryLive(db, key, ctx, now);
    if (live) return { query: key, source: "live", products: live };
    const snap = loadSnapshot(ctx.snapshotFile)?.entries[key];
    if (snap) return { query: key, source: "snapshot", products: snap };
  } catch {
    // any internal failure degrades to "nothing"
  }
  return { query: key, source: "none", products: [] };
}
