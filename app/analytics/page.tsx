import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Bars } from "@/components/analytics/Bars";
import { LazyAgentGrid, LazyDisputeGrid, LazySalesGrid, LazyUnmetGrid } from "@/components/analytics/LazyAnalytics";
import { ShopSwitcher } from "@/components/shell/ShopSwitcher";
import { Badge, Card, EmptyState } from "@/components/ui";
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
import { clientIp } from "@/lib/ratelimit";
import { loadActiveShop } from "@/lib/shop-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

type Result<T> = { ok: true; data: T } | { ok: false };
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

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const { shop: wanted } = await searchParams;
  const data = loadActiveShop(await currentWorkspaceId(), wanted);
  if (!data) {
    return (
      <div className="page">
        <EmptyState title="No shop yet">Set up a shop first, then its sales and agent traffic show up here.</EmptyState>
      </div>
    );
  }
  const { db, shop } = data;
  const ip = clientIp(await headers());

  const [sales, traffic, agents, unmet, disputes, counts] = await Promise.all([
    guard<DayPoint[]>(() => salesByDay(db, shop.id)),
    guard<TrafficDay[]>(() => searchesByDay(db, shop.id)),
    guard<AgentRow[]>(() => searchesByAgent(db, shop.id)),
    guard<UnmetWithSuggestions[]>(() => withSuggestions(db, unmetDemand(db, shop.id), { ip, workspace: null })),
    guard<DisputeRow[]>(() => disputesList(db, shop.id)),
    guard<Counts>(() => dataCounts(db, shop.id)),
  ]);
  const st = <T,>(r: Result<T>, n: number): "error" | "empty" | "ok" => (!r.ok ? "error" : n === 0 ? "empty" : "ok");
  const demo = counts.ok ? counts.data.demo_orders + counts.data.demo_searches + counts.data.demo_disputes : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>What agents searched for, what they bought and what went wrong, for the last 30 days.</p>
        </div>
        <div className="row">
          <Badge tone="accent">{shop.name}</Badge>
          <ShopSwitcher shops={data.shops} active={shop.slug} />
        </div>
      </div>

      {counts.ok && demo > 0 && (
        <div className="notice" data-tone="warning" data-testid="demo-banner">
          <b>Demo data.</b> Rows marked &ldquo;Demo&rdquo; are fake history seeded on every start ({counts.data.demo_orders} orders, {counts.data.demo_searches} searches,{" "}
          {counts.data.demo_disputes} disputes) so these tables are not empty. They never appear in real orders, receipts or disputes and never touch PayPal.
        </div>
      )}

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
    </div>
  );
}
