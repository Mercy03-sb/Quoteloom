import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_STORES, renderDemoShopPage } from "@/lib/demo-shops";
import { resetLlmCooldown } from "@/lib/llm";
import { draftFromCsv, parseCsv } from "@/lib/ingest/csv";
import { cleanDraft, findProblems, parsePriceToCents } from "@/lib/ingest/draft";
import { extractStructured, productFromOpenGraph } from "@/lib/ingest/extract";
import { finalizeDraft, ingestUrl, makeFetcher, pickProductLinks, type PageFetcher, type StepEvent } from "@/lib/ingest/pipeline";
import { findPrice, parseRuleBased } from "@/lib/ingest/rules";
import { openDb } from "@/lib/db";
import { parseLlmProducts } from "@/lib/ingest/normalise";

const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const ORIGIN = "http://localhost:3000";
const PAD = "<p>Welcome to our little shop. We sell hand made things every week.</p>"; // pages shorter than ~20 chars skip the LLM

describe("parsePriceToCents", () => {
  it.each([
    ["12.50", 1250], ["$1,299.00", 129900], ["12,50", 1250], ["1.299,00", 129900], ["Rs. 450", 45000], [12.5, 1250], ["0", 0],
  ])("%s -> %s", (input, cents) => expect(parsePriceToCents(input)).toBe(cents));
  it.each(["", "free", "abc", null, undefined, -3])("rejects %s", (input) => expect(parsePriceToCents(input)).toBeNull());
});

describe("JSON-LD and Open Graph extraction", () => {
  it("reads a Product with an Offer", () => {
    const html = ld({ "@context": "https://schema.org", "@type": "Product", name: "Mug", sku: "m-1", description: "A mug", offers: { "@type": "Offer", price: "24.00", priceCurrency: "EUR", availability: "https://schema.org/InStock" } });
    expect(extractStructured(html)).toMatchObject({ method: "jsonld", products: [{ sku: "m-1", title: "Mug", price_cents: 2400, currency: "EUR", stock: 10 }] });
  });

  it("reads @graph, ItemList, offers arrays, AggregateOffer.lowPrice and out-of-stock", () => {
    const html = ld({
      "@graph": [
        { "@type": "WebSite", name: "Shop" },
        { "@type": "ItemList", itemListElement: [
          { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "A", offers: [{ price: 5, priceCurrency: "USD" }] } },
          { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "B", offers: { "@type": "AggregateOffer", lowPrice: "7.25", availability: "OutOfStock" } } },
        ] },
      ],
    });
    const r = extractStructured(html);
    expect(r.products.map((p) => [p.title, p.price_cents, p.stock])).toEqual([["A", 500, 10], ["B", 725, 0]]);
  });

  it("expands a ProductGroup into its variants", () => {
    const html = ld({ "@type": "ProductGroup", name: "Tee", hasVariant: [{ "@type": "Product", name: "Tee S", sku: "T-S", offers: { price: "20" } }, { "@type": "Product", name: "Tee M", sku: "T-M", offers: { price: "20" } }] });
    expect(extractStructured(html).products.map((p) => p.sku)).toEqual(["T-S", "T-M"]);
  });

  it("tolerates broken JSON-LD blocks next to a good one", () => {
    const html = `<script type="application/ld+json">{ not json</script>` + ld({ "@type": "Product", name: "Ok", offers: { price: "3" } });
    expect(extractStructured(html).products).toHaveLength(1);
  });

  it("falls back to Open Graph product tags when there is no JSON-LD", () => {
    const html = `<head><meta property="og:type" content="product"><meta property="og:title" content="Lamp &amp; shade"><meta property="product:price:amount" content="45.00"><meta property="product:price:currency" content="GBP"></head>`;
    expect(extractStructured(html)).toMatchObject({ method: "opengraph", products: [{ title: "Lamp & shade", price_cents: 4500, currency: "GBP" }] });
    expect(productFromOpenGraph("<head><meta property='og:type' content='website'></head>")).toBeNull();
  });

  it("returns nothing for a page with no structured data", () => {
    expect(extractStructured("<h1>Hello</h1>")).toMatchObject({ method: "none", products: [] });
  });
});

describe("rule-based parser", () => {
  it("parses product cards on the unstructured demo store", () => {
    const html = renderDemoShopPage("/demo-shops/sunday-market") as string;
    expect(extractStructured(html).products).toHaveLength(0); // proves it really has no structured data
    const rows = parseRuleBased(html);
    expect(rows.map((r) => r.title)).toEqual(["Wildflower honey jar", "Tomato chutney", "Sourdough loaf", "Beeswax candle pair", "Market tote bag"]);
    expect(rows.find((r) => r.title.startsWith("Tomato"))).toMatchObject({ price_cents: 750, currency: "USD" });
    expect(rows.find((r) => r.title.startsWith("Beeswax"))?.stock).toBe(0); // "Sold out"
  });

  it("keeps a card together when its inner parts also have product-ish class names", () => {
    const html = `<ul>
      <li class="product-card"><div class="product-image"><img alt="x"></div><h3 class="product-title">Wool hat</h3><span class="product-price">€19,90</span></li>
      <li class="product-card"><h3 class="product-title">Wool scarf</h3><span class="product-price">€29,00</span><p>Long and warm for winter.</p></li></ul>`;
    const rows = parseRuleBased(html);
    expect(rows.map((r) => [r.title, r.price_cents, r.currency])).toEqual([["Wool hat", 1990, "EUR"], ["Wool scarf", 2900, "EUR"]]);
    expect(rows[1].description).toBe("Long and warm for winter.");
  });

  it("falls back to a single product page: h1 plus first price", () => {
    const html = `<meta name="description" content="Nice chair"><h1>Oak chair</h1><p>Only ₹ 4,500.00 today</p>`;
    expect(parseRuleBased(html)).toMatchObject([{ title: "Oak chair", price_cents: 450000, currency: "INR", description: "Nice chair" }]);
  });

  it("ignores scripts, comments and does not mistake sizes for prices", () => {
    expect(findPrice("Pack of 6, 180 x 30 cm")).toBeNull();
    expect(findPrice("Now 12.50 USD")).toEqual({ cents: 1250, currency: "USD" });
    expect(parseRuleBased("<script>var price='$5.00'</script><!-- <h1>Hidden</h1> $9.00 -->")).toEqual([]);
  });

  it("returns nothing for a page without products", () => {
    expect(parseRuleBased("<h1>About us</h1><p>We make things.</p>")).toEqual([]);
  });
});

describe("CSV", () => {
  it("parses quotes, escaped quotes, CRLF, BOM and blank lines", () => {
    const text = '﻿sku,title,price\r\nA-1,"Mug, large","12.50"\r\n\r\nA-2,"The ""best"" cup",3\r\n';
    expect(parseCsv(text)).toEqual([["sku", "title", "price"], ["A-1", "Mug, large", "12.50"], ["A-2", 'The "best" cup', "3"]]);
  });

  it("maps header aliases and builds a draft", () => {
    const r = draftFromCsv("Name,Cost To Buyer,Qty,Desc\nMug,$12.50,4,Nice\nBowl,9,,\n");
    expect(r.error).toBeUndefined();
    expect(r.products).toMatchObject([
      { sku: "MUG", title: "Mug", price_cents: 1250, stock: 4, description: "Nice", currency: "USD" },
      { sku: "BOWL", title: "Bowl", price_cents: 900, stock: 10 },
    ]);
  });

  it("flags bad prices as 0 with a warning instead of dropping the row", () => {
    const r = draftFromCsv("title,price\nThing,call us\n");
    expect(r.products[0].price_cents).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/price not understood/);
  });

  it("explains missing columns and empty files", () => {
    expect(draftFromCsv("sku,price\nA,1").error).toMatch(/title column/);
    expect(draftFromCsv("title\nA").error).toMatch(/price column/);
    expect(draftFromCsv("title,price\n").error).toBeTruthy();
    expect(draftFromCsv("").error).toBeTruthy();
  });

  it("reads the shipped sample CSV", async () => {
    const fs = await import("node:fs");
    const r = draftFromCsv(fs.readFileSync("public/sample-products.csv", "utf8"));
    expect(r.error).toBeUndefined();
    expect(r.products).toHaveLength(8);
    expect(cleanDraft(r.products).errors).toEqual([]);
  });
});

describe("draft validation", () => {
  const ok = { sku: "a-1", title: "Thing", description: "", price_cents: 100, currency: "usd", stock: 1 };
  it("normalises SKU and currency and fills a missing SKU from the title", () => {
    expect(cleanDraft([ok, { ...ok, sku: "", title: "Blue Mug!" }]).rows.map((r) => [r.sku, r.currency])).toEqual([["A-1", "USD"], ["BLUE-MUG", "USD"]]);
  });
  it.each([
    [{ ...ok, title: " " }, /title/],
    [{ ...ok, price_cents: 0 }, /price/],
    [{ ...ok, price_cents: 1.5 }, /price/],
    [{ ...ok, price_cents: 1e12 }, /price/],
    [{ ...ok, currency: "DOLLARS" }, /currency/],
    [{ ...ok, stock: -1 }, /stock/],
    ["nope", /not a product/],
  ])("rejects %j", (row, msg) => expect(cleanDraft([row]).errors.join(" ")).toMatch(msg));
  it("rejects duplicate SKUs", () => expect(cleanDraft([ok, { ...ok, title: "Other" }]).errors[0]).toMatch(/duplicate SKU/));
  it("findProblems agrees with cleanDraft for the grid", () => {
    const rows = [{ _id: "1", ...ok }, { _id: "2", ...ok, title: "Other" }, { _id: "3", ...ok, sku: "z", price_cents: 0 }];
    expect(findProblems(rows)).toEqual({ "1": ["sku"], "2": ["sku"], "3": ["price"] });
  });
});

describe("pipeline", () => {
  beforeEach(() => resetLlmCooldown());
  const db = () => openDb(":memory:");
  const fetcher = makeFetcher(ORIGIN);

  it("ingests a structured demo store from JSON-LD and reports each step", async () => {
    const steps: StepEvent[] = [];
    const r = await ingestUrl(db(), `${ORIGIN}/demo-shops/clay-and-kiln`, { fetchPage: fetcher, selfOrigin: ORIGIN, env: {}, onStep: (e) => steps.push(e) });
    expect(r.products).toHaveLength(6);
    expect(r.methods).toEqual({ jsonld: 6, opengraph: 0, llm: 0, rules: 0 }); // each product counted once, though it appears on two pages
    expect(r.products.find((p) => p.sku === "CK-MUG-WHT")).toMatchObject({ price_cents: 2400, currency: "USD", stock: 10 });
    expect(r.products.find((p) => p.sku === "CK-BAKE-OV")?.stock).toBe(0);
    expect(r.shopName).toBe("Clay & Kiln");
    expect([...new Set(steps.map((s) => s.id))]).toEqual(["validate", "fetch", "discover", "pages", "extract", "draft"]);
    expect(steps.at(-1)).toMatchObject({ id: "draft", status: "done" });
  });

  it("works with no env at all: rule-based parser for an unstructured store", async () => {
    const r = await ingestUrl(db(), `${ORIGIN}/demo-shops/sunday-market`, { fetchPage: fetcher, selfOrigin: ORIGIN, env: {} });
    expect(r.products).toHaveLength(5);
    expect(r.methods).toMatchObject({ jsonld: 0, llm: 0, rules: 5 });
  });

  it("an index page pulls products from the linked stores (structured data wins, no LLM)", async () => {
    const fetchImpl = vi.fn();
    const r = await ingestUrl(db(), `${ORIGIN}/demo-shops`, { fetchPage: fetcher, selfOrigin: ORIGIN, env: { GEMINI_API_KEY: "k" }, fetchImpl });
    expect(r.products.length).toBeGreaterThanOrEqual(12);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves only real /demo-shops pages in-process; unknown ones are 404, other origins go to the safe fetcher", async () => {
    await expect(fetcher(`${ORIGIN}/demo-shops/nope`)).rejects.toMatchObject({ code: "bad_status" });
    await expect(fetcher("http://127.0.0.1/demo-shops")).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(fetcher(`${ORIGIN}/admin`)).rejects.toMatchObject({ code: "unsafe_url" }); // same origin but not a demo page: still SSRF-checked
  });

  it("rejects unsafe start URLs before fetching anything", async () => {
    const fetchPage = vi.fn<PageFetcher>();
    for (const u of ["http://localhost/", "http://169.254.169.254/", "file:///etc/passwd", "ftp://x.example/", "nonsense"]) {
      await expect(ingestUrl(db(), u, { fetchPage, selfOrigin: ORIGIN, env: {} })).rejects.toMatchObject({ code: "unsafe_url" });
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("reads at most 20 linked pages, same origin only", async () => {
    const links = Array.from({ length: 35 }, (_, i) => `<a href="/products/p${i}">p${i}</a>`).join("") + `<a href="https://other.example/products/x">other</a>`;
    const fetchPage = vi.fn<PageFetcher>(async (u) => ({ url: u, status: 200, contentType: "text/html", text: u.endsWith("/") ? `<h1>Home</h1>${links}` : `<h1>Item</h1>` }));
    await ingestUrl(db(), "https://shop.example/", { fetchPage, selfOrigin: null, env: {} });
    const urls = fetchPage.mock.calls.map((c) => c[0]);
    expect(urls).toHaveLength(21); // main + 20
    expect(urls.every((u) => u.startsWith("https://shop.example/"))).toBe(true);
  });

  it("skips pages that fail to load and says so", async () => {
    const fetchPage: PageFetcher = async (u) => {
      if (u.endsWith("/bad")) throw new Error("boom");
      return { url: u, status: 200, contentType: "text/html", text: u.endsWith("/") ? `<a href="/products/bad">x</a><a href="/products/ok">y</a>` : ld({ "@type": "Product", name: "Ok", offers: { price: "5" } }) };
    };
    const r = await ingestUrl(db(), "https://shop.example/", { fetchPage, selfOrigin: null, env: {} });
    expect(r.products).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/Skipped .*bad/);
  });

  it("warns when nothing is found and when prices are missing", async () => {
    const empty: PageFetcher = async (u) => ({ url: u, status: 200, contentType: "text/html", text: "<h1>Welcome</h1>" });
    expect((await ingestUrl(db(), "https://shop.example/", { fetchPage: empty, selfOrigin: null, env: {} })).warnings.join(" ")).toMatch(/No products were found/);
    const noPrice: PageFetcher = async (u) => ({ url: u, status: 200, contentType: "text/html", text: ld({ "@type": "Product", name: "Mystery" }) });
    const r = await ingestUrl(db(), "https://shop.example/", { fetchPage: noPrice, selfOrigin: null, env: {} });
    expect(r.products[0].price_cents).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/no price/);
  });

  describe("Gemini fallback", () => {
    const messy = (u: string) => ({ url: u, status: 200, contentType: "text/html", text: "<div>Hand knit socks - twelve dollars. Wool cap - 20 USD. Plenty of pages of text here.</div>" });
    const geminiReply = (products: unknown[]) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ products }) }] } }] }), { status: 200 });

    it("uses Gemini when there is a key and no structured data, and caches by input hash", async () => {
      const database = db();
      const fetchImpl = vi.fn(async () => geminiReply([{ title: "Hand knit socks", price: 12, currency: "USD", in_stock: true }]));
      const opts = { fetchPage: async (u: string) => messy(u), selfOrigin: null, env: { GEMINI_API_KEY: "test-key" }, fetchImpl: fetchImpl as unknown as typeof fetch };
      const first = await ingestUrl(database, "https://shop.example/", opts);
      expect(first.methods.llm).toBe(1);
      expect(first.products[0]).toMatchObject({ title: "Hand knit socks", price_cents: 1200 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.stringify(init.headers)).toContain("x-goog-api-key");
      expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).not.toContain("test-key"); // key in a header, never in the URL
      const second = await ingestUrl(database, "https://shop.example/", opts);
      expect(second.methods.llm).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // served from llm_cache
    });

    it("falls back to the rule-based parser on a 429 and says so", async () => {
      const fetchImpl = vi.fn(async () => new Response("quota", { status: 429 }));
      const r = await ingestUrl(db(), "https://shop.example/", {
        fetchPage: async (u) => ({ ...messy(u), text: PAD + '<li class="product-card"><h3>Socks</h3><span>$12.00</span></li>' }),
        selfOrigin: null,
        env: { GEMINI_API_KEY: "k" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(r.methods).toMatchObject({ llm: 0, rules: 1 });
      expect(r.warnings.join(" ")).toMatch(/Gemini 429/);
    });

    it("falls back on a network error and on garbage output, and honours the cooldown after a 429", async () => {
      const page = async (u: string) => ({ ...messy(u), text: PAD + '<li class="product-card"><h3>Socks</h3><span>$12.00</span></li>' });
      const boom = vi.fn(async () => { throw new Error("offline"); });
      expect((await ingestUrl(db(), "https://shop.example/", { fetchPage: page, selfOrigin: null, env: { GEMINI_API_KEY: "k" }, fetchImpl: boom as unknown as typeof fetch })).methods.rules).toBe(1);
      const junk = vi.fn(async () => geminiReply([{ nothing: true }]));
      expect((await ingestUrl(db(), "https://shop.example/", { fetchPage: page, selfOrigin: null, env: { GEMINI_API_KEY: "k" }, fetchImpl: junk as unknown as typeof fetch })).methods.rules).toBe(1);
      const limited = vi.fn(async () => new Response("", { status: 429 }));
      const opts = { fetchPage: page, selfOrigin: null, env: { GEMINI_API_KEY: "k" }, fetchImpl: limited as unknown as typeof fetch };
      await ingestUrl(db(), "https://shop.example/", opts);
      await ingestUrl(db(), "https://shop.example/", opts);
      expect(limited).toHaveBeenCalledTimes(1); // second run did not hit the API during the cooldown
    });

    it("never calls the network without a key", async () => {
      const fetchImpl = vi.fn();
      await ingestUrl(db(), "https://shop.example/", { fetchPage: async (u) => messy(u), selfOrigin: null, env: {}, fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe("pipeline helpers", () => {
  it("finalizeDraft merges same-title duplicates (preferring the one with a price) and makes SKUs unique", () => {
    const base = { description: "", currency: "USD", stock: 10 };
    const out = finalizeDraft([
      { ...base, sku: "A", title: "Mug", price_cents: 0 },
      { ...base, sku: "A2", title: "mug", price_cents: 500, description: "better" },
      { ...base, sku: "x", title: "One", price_cents: 100 },
      { ...base, sku: "x", title: "Two", price_cents: 100 },
    ]);
    expect(out.map((p) => [p.sku, p.price_cents])).toEqual([["A2", 500], ["X", 100], ["X-2", 100]]);
  });

  it("pickProductLinks ranks product-looking links first and drops cart/login pages", () => {
    const picked = pickProductLinks(["https://s.example/about-us-x", "https://s.example/cart", "https://s.example/products/a", "https://s.example/login", "https://s.example/"], "https://s.example/", 5);
    expect(picked).toEqual(["https://s.example/products/a", "https://s.example/about-us-x"]);
  });

  it("parseLlmProducts clamps and validates model output", () => {
    expect(parseLlmProducts("not json")).toEqual([]);
    const rows = parseLlmProducts(JSON.stringify([{ title: "  Socks ", price: "12.5", currency: "usd", in_stock: false }, { title: "" }, 5]));
    expect(rows).toEqual([{ sku: "SOCKS", title: "Socks", description: "", price_cents: 1250, currency: "USD", stock: 0 }]);
  });
});

describe("demo shop pages", () => {
  it("every page carries JSON-LD or cards, and unknown paths are null", () => {
    expect(renderDemoShopPage("/demo-shops")).toContain("Demo stores");
    for (const s of DEMO_STORES) {
      const html = renderDemoShopPage(`/demo-shops/${s.slug}`) as string;
      expect(html).toContain("Fake demo store");
      expect(html.includes("application/ld+json")).toBe(s.structured);
      if (s.structured) for (const i of s.items) expect(renderDemoShopPage(`/demo-shops/${s.slug}/${i.slug}`)).toContain("product:price:amount");
    }
    expect(renderDemoShopPage("/demo-shops/nope")).toBeNull();
    expect(renderDemoShopPage("/demo-shops/sunday-market/honey")).toBeNull();
    expect(renderDemoShopPage("/elsewhere")).toBeNull();
  });
});
