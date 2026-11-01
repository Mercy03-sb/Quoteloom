import { CatalogView } from "@/components/catalog/CatalogView";
import { EmptyState } from "@/components/ui";
import { loadPrimaryShop } from "@/lib/shop-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Catalog" };

export default function CatalogPage() {
  const data = loadPrimaryShop();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Catalog</h1>
          <p>What buyer agents can find and quote. Switch to the table to sort and filter.</p>
        </div>
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
