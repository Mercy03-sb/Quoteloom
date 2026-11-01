import { formatCents } from "@/lib/catalog";
import { weaveFor, weaveStyle } from "@/lib/design/weave";
import { Badge } from "@/components/ui";
import { stockLabel, stockTone, type CatalogRow } from "./types";

export function ProductCard({ product }: { product: CatalogRow }) {
  const swatch = weaveStyle(weaveFor(product));
  return (
    <article className="product">
      <div className="product-swatch" style={swatch} aria-hidden="true" />
      <div className="product-body">
        <h3 className="product-title">{product.title}</h3>
        <p className="product-desc">{product.description}</p>
        <div className="product-foot">
          <span className="price">
            {formatCents(product.price_cents)} <span className="stat-note">{product.currency}</span>
          </span>
          <Badge tone={stockTone(product.stock)}>{stockLabel(product.stock)}</Badge>
        </div>
        <code className="stat-note">{product.sku}</code>
      </div>
    </article>
  );
}
