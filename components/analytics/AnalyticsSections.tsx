import type { ReactNode } from "react";
import { Bars } from "@/components/analytics/Bars";
import { LazyAgentGrid, LazyDisputeGrid, LazySalesGrid, LazyUnmetGrid } from "@/components/analytics/LazyAnalytics";
import { Card, EmptyState } from "@/components/ui";
import {
  dataCounts,
  disputesList,
  salesByDay,
  searchesByAgent,
  searchesByDay,
  unmetDemand,
  withSuggestions,
  type AgentRow,
  type Counts,
  type DayPoint,
  type DisputeRow,
  type TrafficDay,
  type UnmetWithSuggestions,
} from "@/lib/analytics";
import type { DB } from "@/lib/db";

// The four analytics sections (AG Grid Community), shared by /analytics and by the /studio fallback.
export type Result<T> = { ok: true; data: T } | { ok: false };
async function guard<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    console.error("[analytics] section failed:", e instanceof Error ? e.message : "unknown error");
    return { ok: false };
  }
}

/** One section: heading, then an error notice, an empty state, or the content. */
function Section({ id, title, intro, state, empty, children }: { id: string; title: string; intro: string; state: "error" | "empty" | "ok"; empty: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="stack" data-section={id} data-state={state}>
      <div>
        <h2 id={`${id}-h`}>{title}</h2>
        <p className="stat-note">{intro}</p>
      </div>
      {state === "error" ? (
        <div className="notice" data-tone="danger" role="alert">This section could not be loaded. The rest of the page is unaffected; reload to try again.</div>
      ) : state === "empty" ? (
        <EmptyState title={`No ${title.toLowerCase()} yet`}>{empty}</EmptyState>
      ) : (
        children
      )}
    </section>
  );
}

export type AnalyticsData = {
  sales: Result<DayPoint[]>;
  traffic: Result<TrafficDay[]>;
  agents: Result<AgentRow[]>;
  unmet: Result<UnmetWithSuggestions[]>;
  disputes: Result<DisputeRow[]>;
  counts: Result<Counts>;
};

export async function loadAnalytics(db: DB, shopId: number, ip: string): Promise<AnalyticsData> {
  const [sales, traffic, agents, unmet, disputes, counts] = await Promise.all([
    guard<DayPoint[]>(() => salesByDay(db, shopId)),
    guard<TrafficDay[]>(() => searchesByDay(db, shopId)),
    guard<AgentRow[]>(() => searchesByAgent(db, shopId)),
    guard<UnmetWithSuggestions[]>(() => withSuggestions(db, unmetDemand(db, shopId), { ip, workspace: null })),
    guard<DisputeRow[]>(() => disputesList(db, shopId)),
    guard<Counts>(() => dataCounts(db, shopId)),
  ]);
  return { sales, traffic, agents, unmet, disputes, counts };
}

/** Warns that seeded demo history is mixed in. Rendered once per page. */
export function DemoBanner({ counts }: { counts: Counts | null }) {
  const demo = counts ? counts.demo_orders + counts.demo_searches + counts.demo_disputes : 0;
  if (!counts || demo === 0) return null;
  return (
    <div className="notice" data-tone="warning" data-testid="demo-banner">
      <b>Demo data.</b> Rows marked &ldquo;Demo&rdquo; are fake history seeded on every start ({counts.demo_orders} orders, {counts.demo_searches} searches, {counts.demo_disputes} disputes) so these tables
      are not empty. They never appear in real orders, receipts or disputes and never touch PayPal.
    </div>
  );
}

export function AnalyticsSections({ data, hideBanner = false }: { data: AnalyticsData; hideBanner?: boolean }) {
  const { sales, traffic, agents, unmet, disputes, counts } = data;
  const st = <T,>(r: Result<T>, n: number): "error" | "empty" | "ok" => (!r.ok ? "error" : n === 0 ? "empty" : "ok");
  return (
    <>
      {!hideBanner && <DemoBanner counts={counts.ok ? counts.data : null} />}

      <Section id="sales" title="Sales" intro="Orders created per day; revenue counts paid orders only." state={st(sales, sales.ok ? sales.data.length : 0)} empty="Orders will appear here once an agent checks out.">
        {sales.ok && (
          <>
            <Bars label="Orders" unit="orders" points={sales.data.map((d) => ({ day: d.day, value: d.orders }))} />
            <LazySalesGrid rows={sales.ok ? sales.data : []} />
          </>
        )}
      </Section>

      <Section id="traffic" title="Agent traffic" intro="Searches per day and per agent id (the agent id is self-reported)." state={st(traffic, traffic.ok ? traffic.data.length : 0)} empty="Searches from agents will appear here.">
        {traffic.ok && (
          <>
            <Bars label="Searches" unit="searches" points={traffic.data.map((d) => ({ day: d.day, value: d.searches }))} />
            {agents.ok ? <LazyAgentGrid rows={agents.data} /> : <div className="notice" data-tone="danger" role="alert">Per-agent table could not be loaded.</div>}
          </>
        )}
      </Section>

      <Section
        id="unmet"
        title="Unmet demand"
        intro="Searches that found nothing (or one weak match), grouped. Suggestions are similar items from other retailers (Channel3), not exact matches."
        state={st(unmet, unmet.ok ? unmet.data.length : 0)}
        empty="Every search found something. Searches with no results will be listed here."
      >
        {unmet.ok && <LazyUnmetGrid rows={unmet.data} />}
      </Section>

      <Section id="disputes" title="Disputes" intro="Disputes opened against orders." state={st(disputes, disputes.ok ? disputes.data.length : 0)} empty="No disputes. Good.">
        {disputes.ok && (
          <Card flat>
            <LazyDisputeGrid rows={disputes.data} />
          </Card>
        )}
      </Section>
    </>
  );
}
