import { LazyDisputesTable } from "@/components/orders/LazyTables";
import { OrdersTabs } from "@/components/orders/OrdersTabs";
import { getDb } from "@/lib/db";
import { listDisputes } from "@/lib/disputes";
import { visibleShopIds } from "@/lib/orders-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Disputes" };

export default async function DisputesPage() {
  const db = getDb();
  const rows = listDisputes(db, visibleShopIds(db, await currentWorkspaceId()));
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Orders &amp; disputes</h1>
          <p>Each dispute comes with an evidence packet built from what the shop stored: the request, the negotiation, the signed quote and the order.</p>
        </div>
      </div>
      <OrdersTabs active="disputes" />
      <LazyDisputesTable rows={rows} />
    </div>
  );
}
