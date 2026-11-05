// Dataset names and field definitions for the AG Studio dashboard. No imports, so the browser bundle can use it.
export const STUDIO_TABLES = ["orders", "searches", "unmet_demand", "disputes"] as const;
export type StudioTable = (typeof STUDIO_TABLES)[number];
export const isStudioTable = (v: unknown): v is StudioTable => (STUDIO_TABLES as readonly unknown[]).includes(v);

export type StudioField = { id: string; name: string; format: "textFormat" | "integerFormat" | "decimalFormat" };

const text = (id: string, name: string): StudioField => ({ id, name, format: "textFormat" });
const int = (id: string, name: string): StudioField => ({ id, name, format: "integerFormat" });
const dec = (id: string, name: string): StudioField => ({ id, name, format: "decimalFormat" });
const origin = text("data_origin", "Data (Demo or Live)");

/** Fields per table. Dates are ISO text (YYYY-MM-DD) so they sort and group as categories. */
export const STUDIO_FIELDS: Record<StudioTable, StudioField[]> = {
  orders: [text("order_id", "Order"), text("status", "Status"), dec("amount", "Amount (USD)"), text("date", "Date"), origin],
  searches: [text("query", "Search"), text("agent_id", "Agent"), int("results", "Results"), text("date", "Date"), origin],
  unmet_demand: [
    text("query", "Search"),
    int("searches", "Searches"),
    int("agents", "Agents"),
    int("zero_results", "No results"),
    int("weak_results", "Weak results"),
    text("last_seen", "Last seen"),
    text("suggestions", "Similar items (Channel3)"),
    text("suggestion_source", "Suggestion source"),
    origin,
  ],
  disputes: [text("dispute_id", "Dispute"), text("order_id", "Order"), text("reason", "Reason"), text("status", "Status"), dec("amount", "Amount (USD)"), text("date", "Date"), origin],
};

export const STUDIO_TABLE_NAMES: Record<StudioTable, string> = { orders: "Orders", searches: "Searches", unmet_demand: "Unmet demand", disputes: "Disputes" };

