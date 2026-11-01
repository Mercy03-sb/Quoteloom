export type CatalogRow = {
  sku: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  stock: number;
  /** Display-only attributes (material, colour). Never margin or cost data. */
  attrs?: { material?: string; color?: string };
};

export function stockTone(stock: number): "danger" | "warning" | "success" {
  if (stock <= 0) return "danger";
  return stock <= 5 ? "warning" : "success";
}

export function stockLabel(stock: number): string {
  if (stock <= 0) return "Out of stock";
  return stock <= 5 ? `Low: ${stock} left` : `${stock} in stock`;
}
