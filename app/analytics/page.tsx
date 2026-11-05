import { headers } from "next/headers";
import { AnalyticsSections, DemoBanner, loadAnalytics } from "@/components/analytics/AnalyticsSections";
import { ShopSwitcher } from "@/components/shell/ShopSwitcher";
import { Badge, EmptyState } from "@/components/ui";
import { clientIp } from "@/lib/ratelimit";
import { loadActiveShop } from "@/lib/shop-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

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

  const analytics = await loadAnalytics(db, shop.id, ip);

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

      <DemoBanner counts={analytics.counts.ok ? analytics.counts.data : null} />
      <AnalyticsSections data={analytics} hideBanner />
    </div>
  );
}
