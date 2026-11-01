import { LazyOrdersTable } from "@/components/orders/LazyTables";
import { OrdersTabs } from "@/components/orders/OrdersTabs";
import { getDb } from "@/lib/db";
import { listOrders, visibleShopIds } from "@/lib/orders-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders" };

export default async function OrdersPage() {
  const db = getDb();
  const rows = listOrders(db, visibleShopIds(db, await currentWorkspaceId()));
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Orders &amp; disputes</h1>
          <p>Every order from buyer agents, with the price they negotiated. Click a row for the full story.</p>
        </div>
      </div>
      <OrdersTabs active="orders" />
      <LazyOrdersTable rows={rows} />
    </div>
  );
}
