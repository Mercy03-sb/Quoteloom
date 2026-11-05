// Believable FAKE history for the demo shop so the analytics page is never empty.
// Every row carries is_demo = 1. Demo orders have no quote and no PayPal id, so no capture, webhook, receipt or
// dispute-submission flow can reach them (those flows also filter is_demo = 0). Deterministic and idempotent:
// seedDemoHistory deletes the old demo rows first, and seed() runs it on every boot.
import type { DB } from "./db";
import { DEMO_PRODUCTS, DEMO_UNMET_QUERIES } from "./seed-data";

export const DEMO_DAYS = 30;
const AGENTS = ["claude-desktop", "quoteloom-buyer-chat", "gpt-shopper", "gemini-agent", "perplexity-buyer"];
const KNOWN_QUERIES: [string, number][] = [
  ["merino scarf", 2], ["wool scarf", 2], ["linen throw", 2], ["cotton napkins", 1], ["weaving kit", 1],
  ["gift for knitter", 3], ["tea towels", 1], ["wool rug", 1], ["canvas tote", 1], ["linen apron", 1],
];
// Weak results (1 hit) are only worth listing for queries the shop answers poorly.
const WEAK_QUERIES: [string, number][] = [["wool blanket", 1], ["organic cotton throw", 1]];

const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

export function seedDemoHistory(db: DB, shopId: number, now: Date = new Date()): { searches: number; orders: number; disputes: number } {
  const at = (daysAgo: number, hour: number, minute: number): string => {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    d.setUTCHours(hour, minute, 0, 0);
    return sqlTime(d);
  };
  let searches = 0;
  let orders = 0;
  let disputes = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM disputes WHERE is_demo = 1").run();
    db.prepare("DELETE FROM orders WHERE is_demo = 1").run();
    db.prepare("DELETE FROM search_log WHERE is_demo = 1").run();

    const addSearch = db.prepare("INSERT INTO search_log (shop_id, query, results_count, agent_id, is_demo, ts) VALUES (?, ?, ?, ?, 1, ?)");
    // Searches: every day gets traffic, growing a little over the month; unmet demand repeats so groups have counts.
    for (let day = DEMO_DAYS - 1; day >= 0; day--) {
      const perDay = 3 + ((day * 7) % 5) + Math.floor((DEMO_DAYS - day) / 6);
      for (let i = 0; i < perDay; i++) {
        const n = day * 13 + i * 5;
        const agent = AGENTS[(n + i) % AGENTS.length];
        let q: string;
        let results: number;
        const pick = n % 10;
        if (pick < 4) {
          [q, results] = KNOWN_QUERIES[n % KNOWN_QUERIES.length];
        } else if (pick < 9) {
          q = DEMO_UNMET_QUERIES[(day * 3 + i * 7) % DEMO_UNMET_QUERIES.length];
          results = 0;
        } else {
          [q, results] = WEAK_QUERIES[n % WEAK_QUERIES.length];
        }
        addSearch.run(shopId, q, results, agent, at(day, 8 + ((n + i) % 12), (n * 7) % 60));
        searches++;
      }
    }

    // Orders: one to three a day on most days, mostly PAID, a few created-only, failed or refunded.
    const addOrder = db.prepare(
      "INSERT INTO orders (id, shop_id, quote_id, paypal_order_id, status, amount_cents, created_at, captured_at, is_demo) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 1)",
    );
    const orderIds: { id: string; amount: number; refunded: boolean }[] = [];
    for (let day = DEMO_DAYS - 1; day >= 0; day--) {
      const count = day % 7 === 3 ? 0 : 1 + ((day * 5) % 3);
      for (let i = 0; i < count; i++) {
        const n = day * 3 + i;
        const p = DEMO_PRODUCTS[(n * 5) % DEMO_PRODUCTS.length];
        const qty = 1 + (n % 3 === 0 ? 1 : 0);
        const amount = Math.round(p.price_cents * qty * (n % 4 === 0 ? 0.92 : 1)); // some negotiated
        const status = n % 17 === 0 ? "REFUNDED" : n % 11 === 0 ? "FAILED" : n % 13 === 0 ? "CREATED" : "PAID";
        const created = at(day, 9 + ((n * 3) % 10), (n * 11) % 60);
        const id = `demo_ord_${String(orders + 1).padStart(3, "0")}`;
        addOrder.run(id, shopId, status, amount, created, status === "PAID" || status === "REFUNDED" ? created : null);
        if (status === "PAID" || status === "REFUNDED") orderIds.push({ id, amount, refunded: status === "REFUNDED" });
        orders++;
      }
    }

    // A couple of disputes on paid demo orders.
    const addDispute = db.prepare(
      `INSERT INTO disputes (id, order_id, paypal_dispute_id, status, reason, amount_cents, currency, simulated, created_at, is_demo)
       VALUES (?, ?, NULL, ?, ?, ?, 'USD', 1, ?, 1)`,
    );
    const paid = orderIds.filter((o) => !o.refunded);
    const picks: [number, string, string, number][] = [
      [Math.floor(paid.length * 0.2), "RESOLVED", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", 20],
      [Math.floor(paid.length * 0.7), "OPEN", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", 6],
      [Math.floor(paid.length * 0.9), "SUBMITTED", "UNAUTHORISED", 2],
    ];
    for (const [idx, status, reason, daysAgo] of picks) {
      const o = paid[idx];
      if (!o) continue;
      addDispute.run(`demo_dsp_${disputes + 1}`, o.id, status, reason, o.amount, at(daysAgo, 14, 5));
      disputes++;
    }
  })();
  return { searches, orders, disputes };
}
