// Fake demo data only. Prices in integer cents.
export const DEMO_SHOP = {
  slug: "loom-and-thread",
  name: "Loom & Thread (demo)",
  source_url: null as string | null, // the demo shop is seeded, not ingested
  rules: {
    min_margin_pct: 20,
    max_discount_pct: 15,
    negotiation: true,
    max_qty: 20,
    quantity_breaks: [
      { min_qty: 5, discount_pct: 5 },
      { min_qty: 10, discount_pct: 10 },
    ],
  },
};

export type SeedProduct = {
  sku: string;
  title: string;
  description: string;
  price_cents: number;
  stock: number;
  attrs: Record<string, string | number>;
};

export const DEMO_PRODUCTS: SeedProduct[] = [
  { sku: "LT-SCARF-WOOL-GRY", title: "Merino wool scarf, grey", description: "Hand-loomed merino scarf, 180 x 30 cm, soft and warm.", price_cents: 4800, stock: 14, attrs: { material: "merino wool", color: "grey", cost_cents: 2200 } },
  { sku: "LT-SCARF-WOOL-RED", title: "Merino wool scarf, rust red", description: "Hand-loomed merino scarf in rust red, 180 x 30 cm.", price_cents: 4800, stock: 6, attrs: { material: "merino wool", color: "red", cost_cents: 2200 } },
  { sku: "LT-THROW-COT-NAT", title: "Cotton throw blanket, natural", description: "Organic cotton waffle-weave throw, 130 x 170 cm.", price_cents: 8900, stock: 9, attrs: { material: "cotton", color: "natural", cost_cents: 4100 } },
  { sku: "LT-THROW-LIN-BLU", title: "Linen throw blanket, indigo", description: "Stonewashed linen throw dyed indigo, 130 x 170 cm.", price_cents: 11500, stock: 4, attrs: { material: "linen", color: "blue", cost_cents: 5600 } },
  { sku: "LT-TEA-TOWEL-3PK", title: "Linen tea towels (3 pack)", description: "Three striped linen tea towels for the kitchen, 50 x 70 cm.", price_cents: 2600, stock: 40, attrs: { material: "linen", cost_cents: 1000 } },
  { sku: "LT-NAPKIN-6PK", title: "Cotton dinner napkins (6 pack)", description: "Woven cotton napkins with hemmed edges, 45 x 45 cm.", price_cents: 3200, stock: 25, attrs: { material: "cotton", cost_cents: 1300 } },
  { sku: "LT-CUSHION-JUTE", title: "Jute cushion cover", description: "Textured jute and cotton cushion cover, 45 x 45 cm, insert not included.", price_cents: 2900, stock: 18, attrs: { material: "jute", cost_cents: 1100 } },
  { sku: "LT-RUG-WOOL-SM", title: "Small wool rug, flatweave", description: "Flatweave wool rug with geometric pattern, 60 x 90 cm.", price_cents: 13900, stock: 3, attrs: { material: "wool", cost_cents: 7000 } },
  { sku: "LT-YARN-MERINO-5", title: "Merino yarn bundle (5 skeins)", description: "Undyed merino DK yarn, 5 x 100 g skeins for knitting.", price_cents: 5500, stock: 22, attrs: { material: "merino wool", cost_cents: 2600 } },
  { sku: "LT-TOTE-CANVAS", title: "Canvas tote bag", description: "Heavy cotton canvas tote with woven strap.", price_cents: 2200, stock: 50, attrs: { material: "cotton", cost_cents: 700 } },
  { sku: "LT-APRON-LIN", title: "Linen apron", description: "Cross-back linen apron with two pockets.", price_cents: 3900, stock: 12, attrs: { material: "linen", cost_cents: 1600 } },
  { sku: "LT-WEAVE-KIT", title: "Beginner weaving kit", description: "Wooden frame loom kit with yarn, shuttle and comb. Great gift.", price_cents: 6400, stock: 7, attrs: { cost_cents: 3000 } },
];
