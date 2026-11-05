import { headers } from "next/headers";
import { AnalyticsSections, DemoBanner, loadAnalytics } from "@/components/analytics/AnalyticsSections";
import { ShopSwitcher } from "@/components/shell/ShopSwitcher";
import { StudioGate } from "@/components/studio/StudioGate";
import { Badge, EmptyState } from "@/components/ui";
import { clientIp } from "@/lib/ratelimit";
import { loadActiveShop } from "@/lib/shop-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Studio" };

// An editable AG Studio dashboard of this shop's own data. If Studio cannot run (no licence, expired trial, load error, small
// screen) the same analytics are shown with AG Grid Community, which is the `fallback` passed to the gate.
export default async function StudioPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const { shop: wanted } = await searchParams;
  const data = loadActiveShop(await currentWorkspaceId(), wanted);
  if (!data) {
    return (
      <div className="page">
        <EmptyState title="No shop yet">Set up a shop first, then build dashboards from its data here.</EmptyState>
      </div>
    );
  }
  const { db, shop } = data;
  const analytics = await loadAnalytics(db, shop.id, clientIp(await headers()));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Studio</h1>
          <p>Build your own dashboard from this shop&apos;s orders, searches, unmet demand and disputes. Edit widgets, or ask the assistant.</p>
        </div>
        <div className="row">
          <Badge tone="accent">{shop.name}</Badge>
          <ShopSwitcher shops={data.shops} active={shop.slug} />
        </div>
      </div>
      <DemoBanner counts={analytics.counts.ok ? analytics.counts.data : null} />
      <StudioGate shop={shop.slug} fallback={<AnalyticsSections data={analytics} hideBanner />} />
    </div>
  );
}
