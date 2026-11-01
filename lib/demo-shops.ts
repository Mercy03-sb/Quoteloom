// Static, fake demo stores served at /demo-shops. Safe ingest targets: they are ours, they are fake,
// and they carry JSON-LD (two stores) or plain unstructured cards (one store, to exercise the fallback parser).

type Item = { slug: string; title: string; description: string; price: string; sku: string; inStock?: boolean };
type Store = { slug: string; name: string; blurb: string; structured: boolean; items: Item[] };

export const DEMO_STORES: Store[] = [
  {
    slug: "clay-and-kiln",
    name: "Clay & Kiln (fake demo store)",
    blurb: "Small-batch stoneware made up for testing Quoteloom.",
    structured: true,
    items: [
      { slug: "speckled-mug", sku: "CK-MUG-WHT", title: "Stoneware mug, speckled white", description: "Wheel-thrown 350 ml mug with a speckled white glaze.", price: "24.00" },
      { slug: "pour-over-dripper", sku: "CK-DRIP-01", title: "Ceramic pour-over dripper", description: "Single-cup coffee dripper that fits most mugs.", price: "32.00" },
      { slug: "serving-bowl", sku: "CK-BOWL-L", title: "Handbuilt serving bowl, large", description: "Handbuilt 28 cm bowl for salads and pasta.", price: "58.00" },
      { slug: "espresso-cups", sku: "CK-ESP-4", title: "Espresso cups (set of 4)", description: "Four small stoneware cups, 80 ml each.", price: "46.00" },
      { slug: "bud-vase", sku: "CK-VASE-CEL", title: "Bud vase, celadon", description: "Slim celadon vase for a single stem.", price: "19.50" },
      { slug: "baking-dish", sku: "CK-BAKE-OV", title: "Oval baking dish", description: "Oven-safe oval dish, 30 x 20 cm.", price: "64.00", inStock: false },
    ],
  },
  {
    slug: "daily-grind",
    name: "Daily Grind Roasters (fake demo store)",
    blurb: "Pretend coffee roaster for testing Quoteloom.",
    structured: true,
    items: [
      { slug: "ethiopia-yirgacheffe", sku: "DG-ETH-250", title: "Ethiopia Yirgacheffe, 250 g", description: "Floral, citrus-bright washed coffee.", price: "16.50" },
      { slug: "colombia-huila", sku: "DG-COL-250", title: "Colombia Huila, 250 g", description: "Caramel and red apple, medium roast.", price: "14.00" },
      { slug: "house-espresso", sku: "DG-ESP-1KG", title: "House espresso blend, 1 kg", description: "Chocolatey blend built for milk drinks.", price: "38.00" },
      { slug: "cold-brew-bags", sku: "DG-CB-8", title: "Cold brew bags (8 pack)", description: "Steep-in-the-jar coffee bags for cold brew.", price: "12.00" },
      { slug: "hand-grinder", sku: "DG-GRIND-H", title: "Hand coffee grinder", description: "Steel burr hand grinder with a ceramic core.", price: "59.00", inStock: false },
      { slug: "sampler-box", sku: "DG-GIFT-3", title: "Gift sampler box", description: "Three 100 g bags and a tasting card.", price: "29.00" },
    ],
  },
  {
    slug: "sunday-market",
    name: "Sunday Market Stall (fake demo store)",
    blurb: "A plain page with no structured data, so the fallback parser has something to do.",
    structured: false,
    items: [
      { slug: "honey", sku: "SM-HONEY", title: "Wildflower honey jar", description: "Raw 340 g jar from a hobby apiary.", price: "11.00" },
      { slug: "chutney", sku: "SM-CHUT", title: "Tomato chutney", description: "Slow-cooked chutney, good with cheese.", price: "7.50" },
      { slug: "sourdough", sku: "SM-BREAD", title: "Sourdough loaf", description: "Fresh country loaf baked on Sundays only.", price: "6.00" },
      { slug: "candles", sku: "SM-CAND", title: "Beeswax candle pair", description: "Two hand-dipped beeswax tapers.", price: "14.00", inStock: false },
      { slug: "tote", sku: "SM-TOTE", title: "Market tote bag", description: "Sturdy canvas bag for carrying your haul.", price: "9.00" },
    ],
  },
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonLd = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;

const CSS =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#1d1d1f}" +
  "a{color:#2f5d8a}.banner{background:#fff6dd;border:1px solid #e8d49a;padding:8px 12px;border-radius:8px;font-size:14px}" +
  ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;list-style:none;padding:0}" +
  ".product-card{border:1px solid #ddd;border-radius:10px;padding:12px}.price{font-weight:700}";

function shell(title: string, head: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title>${head}<style>${CSS}</style></head><body>` +
    `<p class="banner">Fake demo store for testing Quoteloom. Nothing here is for sale.</p>${body}</body></html>`
  );
}

function offer(i: Item) {
  return {
    "@type": "Offer",
    price: i.price,
    priceCurrency: "USD",
    availability: i.inStock === false ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
  };
}

const productNode = (i: Item, store: Store) => ({
  "@type": "Product",
  name: i.title,
  sku: i.sku,
  description: i.description,
  url: `/demo-shops/${store.slug}/${i.slug}`,
  offers: offer(i),
});

function indexPage(): string {
  const links = DEMO_STORES.map((s) => `<li><a href="/demo-shops/${s.slug}">${esc(s.name)}</a><br>${esc(s.blurb)}</li>`).join("");
  return shell("Quoteloom demo stores", "", `<h1>Demo stores</h1><p>Paste any of these into Quoteloom's Setup screen.</p><ul>${links}</ul>`);
}

function storePage(s: Store): string {
  const head = s.structured
    ? jsonLd({
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: s.items.map((i, n) => ({ "@type": "ListItem", position: n + 1, item: productNode(i, s) })),
      }) + `<meta property="og:site_name" content="${esc(s.name)}">`
    : "";
  const cards = s.items
    .map((i) =>
      s.structured
        ? `<li class="product-card"><h3><a href="/demo-shops/${s.slug}/${i.slug}">${esc(i.title)}</a></h3><p>${esc(i.description)}</p><span class="price">$${i.price}</span></li>`
        : `<li class="product-card"><h3>${esc(i.title)}</h3><p>${esc(i.description)}</p><span class="price">$${i.price}</span>${i.inStock === false ? " <em>Sold out</em>" : ""}</li>`,
    )
    .join("");
  return shell(s.name, head, `<h1>${esc(s.name)}</h1><p>${esc(s.blurb)}</p><ul class="grid">${cards}</ul><p><a href="/demo-shops">All demo stores</a></p>`);
}

function itemPage(s: Store, i: Item): string {
  const head =
    jsonLd({ "@context": "https://schema.org", ...productNode(i, s) }) +
    `<meta property="og:type" content="product"><meta property="og:title" content="${esc(i.title)}">` +
    `<meta property="og:description" content="${esc(i.description)}">` +
    `<meta property="product:price:amount" content="${i.price}"><meta property="product:price:currency" content="USD">`;
  return shell(i.title, head, `<h1>${esc(i.title)}</h1><p>${esc(i.description)}</p><p class="price">$${i.price} USD</p><p><a href="/demo-shops/${s.slug}">Back to ${esc(s.name)}</a></p>`);
}

/** HTML for a /demo-shops path, or null when there is no such page. */
export function renderDemoShopPage(pathname: string): string | null {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts[0] !== "demo-shops") return null;
  if (parts.length === 1) return indexPage();
  const store = DEMO_STORES.find((s) => s.slug === parts[1]);
  if (!store) return null;
  if (parts.length === 2) return storePage(store);
  const item = store.structured ? store.items.find((i) => i.slug === parts[2]) : undefined;
  return parts.length === 3 && item ? itemPage(store, item) : null;
}
