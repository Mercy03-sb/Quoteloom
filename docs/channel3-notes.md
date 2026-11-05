# Channel3 API notes (for Milestone 5a)

Source: Channel3 official docs (docs.trychannel3.com, redirects to channel3.ai/docs) and the official
`@channel3/skills` package, collected 2026-11-05. The response sample below is a trimmed REAL live
response (captured 2026-11-05 with our key), so field names and nesting are verified.

## Basics

- Base URL: `https://api.trychannel3.com`
- Auth: header `x-api-key: YOUR_KEY` (env var name used by their SDKs and our `.env.example`: `CHANNEL3_API_KEY`)
- Search and product detail use `/v1`. Enrich, price tracking, brands and websites use `/v0`.
- Use plain `fetch`. Do not install their SDK (keeps the dependency list small and the fallbacks ours).
- The old `/v0/search` and `/v0/products` were removed on 2026-04-13. Only use `/v1/search`.

## Product search: `POST /v1/search`

```bash
curl -X POST https://api.trychannel3.com/v1/search \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"running shoes","filters":{"price":{"max_price":100}},"limit":10}'
```

Request body:

| Field                        | Type    | Notes                                                                                                     |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `query`                      | string  | Free text, natural language or keywords                                                                   |
| `image_url`                  | string  | Visual search by URL (we do not need it)                                                                  |
| `base64_image`               | string  | Visual search by base64 (we do not need it)                                                               |
| `filters`                    | object  | All optional, see below                                                                                   |
| `limit`                      | integer | 1 to 30, default 20                                                                                       |
| `page_token`                 | string  | The previous response's `next_page_token` (we only need page 1)                                           |
| `config.keyword_search_only` | boolean | `true` = exact keyword matching, no semantic search, lowest latency. Cannot be combined with image input. |

Filters (documented names): `price` with `max_price` (a min-price field probably exists; check the API
reference before using it), `gender`, `condition` (`new`, `used`, `refurbished`), `website_ids`,
`exclude_brand_ids`, `exclude_website_ids`, `brand_ids` (resolve ids via `/v1/brands/search`), plus
category, age and availability filters whose exact names are not in the pages I could read.
Every filter is optional. For our use (market price reference and "consider stocking" suggestions) a
plain `{"query": "...", "limit": 5}` is enough. Do not depend on filters.

Note: one docs page mentions `mode: "keyword"` while the skills package says `config.keyword_search_only`.
We do not need either. Use the default semantic search.

## Response shape

`SearchResponse`:

- `products`: `Product[]` (required)
- `next_page_token`: `string | null` (null = no more pages)

`Product`:

- `id` string, `title` string, `description` string | null
- `brands`: `[{ id, name }]` (ordered)
- `images`: `[{ url, cleaned_url | null, is_main_image, shot_type | null, alt_text | null }]`
  - For a grid thumbnail use `cleaned_url ?? url`. `is_cleaned_image` is deprecated and always false.
- `category`: `{ slug, title, path, has_children } | null`
  - VERIFIED LIVE: `path` is an array of objects `{ slug, title }`, not strings.
- `colors`: `[{ hex, percentage }]` and `ratings` (null in the sample) also exist. Ignore both.
- Verified live: `images[].cleaned_url` is often null, so always use `cleaned_url ?? url`. Image
  URLs are on `cdn.trychannel3.com` (and sometimes the retailer's own CDN, e.g. cdn.shopify.com);
  if we render them, allow those hosts in `next.config.ts` `images.remotePatterns`, or use a plain `<img>`.
- Verified live: offer `url` is a `buy.trychannel3.com/...` redirect link (affiliate tracked).
- Verified live: `offer.dimensions` can be an object like `{ length: { number, unit }, width: null, ... }` or null. Ignore.
- Verified live: the first hit for "merino wool sweater" was a women's sweater from Oak and Fort, and titles
  can be odd (e.g. "10% Merino Wool Sweater"). Search is semantic, so it returns similar items, not
  exact matches. Never treat a result as an exact match for a shop product. Treat prices as a range of
  comparable items, and show the title, so the label says "similar items".
- `gender`, `age`, `materials`, `key_features`, `variants`, `structured_attributes` (all optional; ignore)
- `offers`: `ProductOffer[]`. **Price and buy link are on offers, not on the product.** Guard with `?? []`.

`ProductOffer`:

- `url` string (affiliate-tracked retailer link; use as given, never rewrite it)
- `domain` string (retailer domain, for example `nike.com`)
- `price`: `{ price: number, compare_at_price: number | null, currency: string }`
  - Note the nesting: the number is `offer.price.price`. `price` already includes discounts.
- `availability`: `"InStock"` or `"OutOfStock"`
- `condition`: `"new" | "used" | "refurbished" | null`
- `max_commission_rate`: number (decimal, 0.08 = 8%), may be missing
- `dimensions`: object | null (ignore)

Currency: offers carry their own `currency`. Compare only offers in the same currency as the shop
(USD for our demo shops). Skip other currencies rather than converting.

### Sample response (REAL, trimmed from a live call: POST /v1/search {"query":"merino wool sweater","limit":2})

```json
{
  "products": [
    {
      "id": "jYhXmAg",
      "title": "100% Merino Wool Sweater",
      "description": "This lightweight 100% merino wool sweater features a classic, relaxed fit ...",
      "brands": [{ "id": "Fcb6", "name": "Oak and Fort" }],
      "images": [
        {
          "url": "https://cdn.trychannel3.com/5de9b75e-...?aid=...&mid=7Hdn",
          "cleaned_url": null,
          "is_main_image": true,
          "shot_type": "on_model",
          "alt_text": "Woman wearing a dark navy blue striped sweater."
        },
        {
          "url": "https://cdn.trychannel3.com/c3604616-...?aid=...&mid=7Hdn",
          "cleaned_url": "https://cdn.trychannel3.com/cleaned/v1/c3604616-...?aid=...&mid=7Hdn",
          "is_main_image": false,
          "shot_type": "hero",
          "alt_text": "Black merino wool sweater laid flat on a light background."
        }
      ],
      "category": {
        "slug": "sweaters-2",
        "title": "Sweaters",
        "path": [
          { "slug": "apparel-accessories", "title": "Apparel & Accessories" },
          { "slug": "clothing", "title": "Clothing" },
          { "slug": "shirts-tops", "title": "Shirts & Tops" },
          { "slug": "sweaters-2", "title": "Sweaters" }
        ],
        "has_children": false
      },
      "gender": "female",
      "age": "adult",
      "materials": ["100% Merino Wool"],
      "offers": [
        {
          "url": "https://buy.trychannel3.com/jYhXmAg-7Hdn-M4v3JO?o=...&aid=...",
          "domain": "oakandfort.ca",
          "price": {
            "price": 57.0,
            "compare_at_price": 65.0,
            "currency": "USD"
          },
          "availability": "InStock",
          "condition": "new",
          "max_commission_rate": 0.084,
          "dimensions": {
            "length": { "number": 24.0, "unit": "in" },
            "width": null,
            "height": null,
            "weight": null
          }
        }
      ],
      "variants": {
        "options": [
          "Color and Size options, each with label, exists, available, thumbnail_url, product_id"
        ],
        "selected": [{ "name": "Color", "label": "BARITONE NAVY BLUE" }]
      },
      "structured_attributes": { "neckline": ["Crew"], "fabric": ["Merino"] },
      "ratings": null
    },
    {
      "id": "iXm7kES",
      "title": "10% Merino Wool Sweater",
      "brands": [{ "id": "Fcb6", "name": "Oak and Fort" }],
      "offers": [
        {
          "url": "https://buy.trychannel3.com/iXm7kES-7Hdn-M4v3JO?o=...&aid=...",
          "domain": "oakandfort.com",
          "price": {
            "price": 78.0,
            "compare_at_price": 88.0,
            "currency": "USD"
          },
          "availability": "InStock",
          "condition": "new",
          "max_commission_rate": 0.084,
          "dimensions": null
        }
      ]
    }
  ],
  "next_page_token": "eyJjYWNoZV9rZXkiOi..."
}
```

What this live call shows for our logic: both hits were in stock, USD, with one offer each ($57 and $78).
The second title ("10% Merino Wool Sweater") is clearly noisy for a "100% merino" query, so use the median
rather than min/max alone, require at least 2 usable offers before showing a range, and with fewer show
"limited market data". A product can have several offers; take every in-stock offer in the shop's currency.

## Single product: `GET /v1/products/{product_id}`

```bash
curl https://api.trychannel3.com/v1/products/2yh8WH5 -H "x-api-key: YOUR_KEY"
```

Returns one `ProductDetail` (same fields as above, with full offers). Optional `website_ids` query
parameter. We probably don't need it.

## Errors, limits, timeouts

- `401`: invalid or missing key. `429`: rate limited. Other 4xx/5xx: treat as failure.
- Error body format and rate limit numbers are not documented in the pages I could read.
  No retry-after header guidance. Their own SDK retries twice on connection errors, 408, 409, 429, 5xx.
- Their SDK default timeout is 60 s. **Use a much shorter timeout (about 4 s) in our client** and fall
  through to the snapshot. No retry on 429 (just fall through).
- Credits: the hackathon promo (`PAYPAL-HACKATHON-2026`) gives 20,000 free searches. Count every live
  call against our own budget; cache aggressively and keep the snapshot as the final fallback.
- Credits and quotas expire or run out, so judges must never depend on live calls (SPEC rule).

## Mapping to Quoteloom (what we need from a result)

For a shop product or an unmet-demand query, take the top few products and reduce each to:

- `title`
- `image`: first image's `cleaned_url ?? url`
- `retailer`: offer `domain`
- `price`: `offer.price.price`, `currency`: `offer.price.currency`
- `in_stock`: `offer.availability === "InStock"`
- `url`: `offer.url` (affiliate link, shown only on the merchant side, never inside buyer-facing negotiation)

Market reference = min / median / max of the in-stock, same-currency offer prices across the top
results. Label it "Market reference (via Channel3)" for live and cached results, or "snapshot" for
the snapshot file. Information only. `lib/policy.ts` still decides the price.

## Other (optional)

- MCP server: `https://mcp.trychannel3.com/` (free tier; `?apiKey=<key>` for pay-as-you-go). Not needed here.
- CLI: `channel3 products search --query "..."`. Not needed here.

## Verified

A live call with our key succeeded on 2026-11-05 (HTTP 200, 2 products, `next_page_token` present), and
the shapes above match it. The key works, so live calls are available; the snapshot is still the fallback.
If a future live response differs from this document, trust the live response and update this file.
