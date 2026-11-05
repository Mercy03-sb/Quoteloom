// Datasets for the /studio dashboard (AG Studio). Read-only, scoped to one shop the caller may see.
// Deliberately narrow: no floor, cost, rules, quote or PayPal ids. Seeded demo history is labelled "Demo".
import type { DB } from "./db";
import { disputesList, unmetDemand, withSuggestions } from "./analytics";
import type { LookupCtx } from "./channel3";
import type { StudioTable } from "./studio-fields";

export { isStudioTable, STUDIO_FIELDS, STUDIO_TABLES, STUDIO_TABLE_NAMES } from "./studio-fields";

export type StudioRow = Record<string, string | number | null>;

const label = (demo: unknown): string => (demo ? "Demo" : "Live");
const day = (ts: string): string => ts.slice(0, 10);
const dollars = (cents: number): number => Math.round(cents) / 100;
const MAX_ROWS = 5000;

export async function studioRows(db: DB, shopId: number, table: StudioTable, ctx: LookupCtx = {}): Promise<StudioRow[]> {
  if (table === "orders") {
    const rows = db
      .prepare("SELECT id, status, amount_cents, created_at, is_demo FROM orders WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(shopId, MAX_ROWS) as { id: string; status: string; amount_cents: number; created_at: string; is_demo: number }[];
    return rows.map((r) => ({ order_id: r.id, status: r.status, amount: dollars(r.amount_cents), date: day(r.created_at), data_origin: label(r.is_demo) }));
  }
  if (table === "searches") {
    const rows = db
      .prepare("SELECT query, agent_id, results_count, ts, is_demo FROM search_log WHERE shop_id = ? ORDER BY ts DESC LIMIT ?")
      .all(shopId, MAX_ROWS) as { query: string; agent_id: string | null; results_count: number; ts: string; is_demo: number }[];
    return rows.map((r) => ({ query: r.query, agent_id: r.agent_id ?? "(unknown)", results: r.results_count, date: day(r.ts), data_origin: label(r.is_demo) }));
  }
  if (table === "unmet_demand") {
    const rows = await withSuggestions(db, unmetDemand(db, shopId), ctx);
    return rows.map((r) => ({
      query: r.query,
      searches: r.searches,
      agents: r.agents,
      zero_results: r.zero,
      weak_results: r.weak,
      last_seen: day(r.last_seen),
      suggestions: r.suggestions.map((s) => `${s.title} (${s.retailer})`).join("; "),
      suggestion_source: r.source,
      data_origin: r.demo > 0 ? "Demo" : "Live",
    }));
  }
  return disputesList(db, shopId).map((r) => ({
    dispute_id: r.id,
    order_id: r.order_id,
    reason: r.reason,
    status: r.status,
    amount: dollars(r.amount_cents),
    date: day(r.created_at),
    data_origin: label(r.demo),
  }));
}
