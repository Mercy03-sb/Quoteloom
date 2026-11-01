import { CatalogView } from "@/components/catalog/CatalogView";
import { EmptyState } from "@/components/ui";
import { ShopSwitcher } from "@/components/shell/ShopSwitcher";
import { loadActiveShop } from "@/lib/shop-view";
import { currentWorkspaceId } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Catalog" };

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const { shop: wanted } = await searchParams;
  const data = loadActiveShop(await currentWorkspaceId(), wanted);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Catalog</h1>
          <p>What buyer agents can find and quote. Switch to the table to sort and filter.</p>
        </div>
        {data && <ShopSwitcher shops={data.shops} active={data.shop.slug} />}
      </div>
      {data ? (
        <CatalogView rows={data.rows} />
      ) : (
        <EmptyState title="No shop yet">
          Run <code>npm run seed</code> to restore the demo shop.
        </EmptyState>
      )}
    </div>
  );
}
