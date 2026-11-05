// Read-only analytics queries for /analytics. Plain SQL, no money decisions. Rows seeded as demo history carry is_demo = 1.
import type { DB } from "./db";
import { lookupChannel3, normaliseQuery, type C3Product, type C3Source, type LookupCtx } from "./channel3";

export const WEAK_MAX_RESULTS = 1; // a search with 0 or 1 hits counts as unmet or weak demand

export type DayPoint = { day: string; orders: number; paid: number; revenue_cents: number; demo: number };
export type TrafficDay = { day: string; searches: number };
export type AgentRow = { agent: string; searches: number; zero_results: number; last_seen: string; demo: number };
export type UnmetRow = { id: string; query: string; searches: number; agents: number; zero: number; weak: number; last_seen: string; demo: number };
export type DisputeRow = { id: string; order_id: string; reason: string; status: string; amount_cents: number; currency: string; created_at: string; demo: number };
export type Counts = { orders: number; searches: number; disputes: number; demo_orders: number; demo_searches: number; demo_disputes: number };

const since = (days: number, now: Date): string => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

export function salesByDay(db: DB, shopId: number, days = 30, now = new Date()): DayPoint[] {
  return db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(status = 'PAID'), 0) AS paid,
              COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount_cents ELSE 0 END), 0) AS revenue_cents, COALESCE(SUM(is_demo), 0) AS demo
         FROM orders WHERE shop_id = ? AND created_at >= ? GROUP BY day ORDER BY day`,
    )
    .all(shopId, since(days, now)) as DayPoint[];
}

export function searchesByDay(db: DB, shopId: number, days = 30, now = new Date()): TrafficDay[] {
  return db
    .prepare("SELECT date(ts) AS day, COUNT(*) AS searches FROM search_log WHERE shop_id = ? AND ts >= ? GROUP BY day ORDER BY day")
    .all(shopId, since(days, now)) as TrafficDay[];
}

export function searchesByAgent(db: DB, shopId: number, days = 30, now = new Date()): AgentRow[] {
  return db
    .prepare(
      `SELECT COALESCE(agent_id, '(unknown)') AS agent, COUNT(*) AS searches, COALESCE(SUM(results_count = 0), 0) AS zero_results,
              MAX(ts) AS last_seen, COALESCE(SUM(is_demo), 0) AS demo
         FROM search_log WHERE shop_id = ? AND ts >= ? GROUP BY agent ORDER BY searches DESC, agent`,
    )
    .all(shopId, since(days, now)) as AgentRow[];
}

/** Searches with zero or weak results, grouped by normalised query. */
export function unmetDemand(db: DB, shopId: number, days = 30, now = new Date(), limit = 20): UnmetRow[] {
  const rows = db
    .prepare(
      `SELECT query, results_count AS n, agent_id, ts, is_demo FROM search_log
        WHERE shop_id = ? AND ts >= ? AND results_count <= ?`,
    )
    .all(shopId, since(days, now), WEAK_MAX_RESULTS) as { query: string; n: number; agent_id: string | null; ts: string; is_demo: number }[];
  const groups = new Map<string, UnmetRow & { agentSet: Set<string> }>();
  for (const r of rows) {
    const key = normaliseQuery(r.query);
    if (!key) continue;
    const g = groups.get(key) ?? { id: key, query: key, searches: 0, agents: 0, zero: 0, weak: 0, last_seen: "", demo: 0, agentSet: new Set<string>() };
    g.searches += 1;
    if (r.n === 0) g.zero += 1;
    else g.weak += 1;
    g.demo += r.is_demo;
    g.agentSet.add(r.agent_id ?? "(unknown)");
    if (r.ts > g.last_seen) g.last_seen = r.ts;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ agentSet, ...g }) => ({ ...g, agents: agentSet.size }))
    .sort((a, b) => b.searches - a.searches || a.query.localeCompare(b.query))
    .slice(0, limit);
}

export type Suggestion = Pick<C3Product, "title" | "price" | "currency" | "retailer" | "image">;
export type UnmetWithSuggestions = UnmetRow & { source: C3Source; suggestions: Suggestion[] };

/** "Consider stocking these": top similar items per group from Channel3 (cache, live within limits, snapshot). No offer URLs. */
export async function withSuggestions(db: DB, rows: UnmetRow[], ctx: LookupCtx = {}, maxLookups = 8, perRow = 3): Promise<UnmetWithSuggestions[]> {
  return Promise.all(
    rows.map(async (r, i) => {
      if (i >= maxLookups) return { ...r, source: "none" as const, suggestions: [] };
      const l = await lookupChannel3(db, r.query, ctx);
      const suggestions = l.products
        .filter((p) => p.in_stock)
        .slice(0, perRow)
        .map(({ title, price, currency, retailer, image }) => ({ title, price, currency, retailer, image }));
      return { ...r, source: l.source, suggestions };
    }),
  );
}

export function disputesList(db: DB, shopId: number): DisputeRow[] {
  return db
    .prepare(
      `SELECT d.id, d.order_id, d.reason, d.status, d.amount_cents, d.currency, d.created_at, d.is_demo AS demo
         FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.shop_id = ? ORDER BY d.created_at DESC`,
    )
    .all(shopId) as DisputeRow[];
}

export function dataCounts(db: DB, shopId: number): Counts {
  const one = (sql: string) => (db.prepare(sql).get(shopId) as { n: number }).n;
  return {
    orders: one("SELECT COUNT(*) AS n FROM orders WHERE shop_id = ?"),
    searches: one("SELECT COUNT(*) AS n FROM search_log WHERE shop_id = ?"),
    disputes: one("SELECT COUNT(*) AS n FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.shop_id = ?"),
    demo_orders: one("SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND is_demo = 1"),
    demo_searches: one("SELECT COUNT(*) AS n FROM search_log WHERE shop_id = ? AND is_demo = 1"),
    demo_disputes: one("SELECT COUNT(*) AS n FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.shop_id = ? AND d.is_demo = 1"),
  };
}
