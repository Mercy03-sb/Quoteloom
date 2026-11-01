# Quoteloom

Agent-ready storefronts for small shops: a catalog, merchant rules and a hosted MCP endpoint that buyer agents can search, negotiate with and (later) pay through PayPal sandbox. See [SPEC.md](SPEC.md).

Fake data only. Sandbox only. No real money.

## Run locally

Requires Node 22 (`engines` in package.json; Render uses 22.9.0).

```bash
npm install && npm run dev
```

Open http://localhost:3000. No environment variables are needed: the app starts in **simulation mode** (PayPal `sim`, LLM `fallback`) and the database is re-seeded with the demo shop on every boot.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start locally (sim mode by default) |
| `npm run seed` | Reset the SQLite DB to the demo state |
| `npm run check:gemini` | One tiny Gemini call with the configured key and model; prints the real error if it fails (`-- --models` lists valid model names) |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Production build |

Optional settings are listed in [.env.example](.env.example). Copy it to `.env.local` to override.

## MCP endpoint

Each shop has a Streamable HTTP MCP endpoint at `/m/{shop}/mcp`. The seeded demo shop is `loom-and-thread`:

```
http://localhost:3000/m/loom-and-thread/mcp
```

Tools:

- `search_products(query, max_price?, limit?)`: keyword search over the shop catalog. `max_price` is in major units (e.g. `50` = $50.00). Every search, including zero-result ones, is logged to `search_log`.
- `request_quote(sku, qty, offer_price?)`: a signed price commitment valid for 10 minutes. Prices come from `lib/policy.ts` and `lib/quote.ts`, never from an LLM. Everything is quoted at list price for now (negotiation is Milestone 4).
- `create_checkout(quote_id)`: verifies the quote signature and expiry, creates a PayPal order (simulated without credentials), returns an `approval_url` a human opens to pay. One order per quote.
- `get_order_status(order_id)`: `CREATED`, `APPROVED`, `PAID`, `FAILED` or `REFUNDED`.

Quick check with curl:

```bash
curl -s http://localhost:3000/m/loom-and-thread/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"merino scarf"}}}'
```

To use it from Claude Desktop, add it as a remote MCP server. Claude Desktop reaches it only over a public HTTPS URL (for example the Render deploy), or locally through a bridge such as `npx mcp-remote http://localhost:3000/m/loom-and-thread/mcp`.

## PayPal sandbox

`lib/paypal.ts` creates Orders v2 through `@paypal/paypal-server-sdk`, written with the **APIMatic Context Plugin for PayPal**. Without `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` it simulates orders and never touches the network. `GET /api/dev/paypal-test` creates an order and returns `{ mode, orderId, approvalUrl }`.

### Buying flow and screens

`/chat` is a built-in buyer agent (no LLM, no account) that calls the same MCP tools and shows every tool call and the signed quote. `/quote/{id}` shows the quote, its HMAC signature check and decision log. `/checkout/{order}` shows the order, progress and audit log. In simulation mode the checkout page has an "Approve and pay (simulated)" button; with sandbox credentials it sends the buyer to PayPal and captures on return.

Quotes are signed with HMAC-SHA256 using `QUOTE_SIGNING_SECRET` (a random per-process secret if unset, so quotes die on restart like the DB). A tampered or expired quote is refused by `create_checkout`.

### Webhooks

`POST /api/webhooks/paypal` verifies the signature before touching anything: in sandbox mode through PayPal's verify-webhook-signature API (needs `PAYPAL_WEBHOOK_ID`; without it every webhook is rejected), in simulation mode through an HMAC header that the app's own simulated webhooks carry. Events are deduplicated by id and order status only moves forward, so a late or repeated event cannot undo a payment.

`/api/dev/*` routes are 404 in production unless `ALLOW_DEV_ROUTES=1`.

## Setting up your own shop (Milestone 3)

Open **Set up a shop** (`/setup`). Paste a URL or upload a CSV, watch the steps (check address, fetch, find product pages, read them, extract, build draft), then review the draft in an editable AG Grid table: click a cell to edit, delete rows, add rows, fix prices (shown as 12.50, stored as integer cents). Outlined cells block **Publish** until fixed. Publishing creates a shop with its own MCP URL (`/m/{slug}/mcp`) and a Copy button. Only ingest sites you own or have permission to use; the screen says so.

Extraction order for a URL: the page plus up to 20 linked pages on the same origin; **JSON-LD** (Product, ProductGroup, ItemList) first, then **Open Graph** product tags; only if a site has neither, **Gemini** normalises the page text (plain `fetch`, key in a header, results cached in `llm_cache` by input hash, at most 3 calls per ingest, 60 s cooldown after a 429); and if there is no `GEMINI_API_KEY`, or Gemini fails or is rate limited, a deterministic **rule-based parser** (product cards and single product pages) takes over. Stock is rarely published, so ingested products default to 10 (0 when the page says out of stock); edit it in the grid. Cost: the whole thing works with no key at all.

CSV columns (header names are matched loosely): `sku, title, description, price, currency, stock`; title and price are required, max 1 MB and 200 rows. [public/sample-products.csv](public/sample-products.csv) is a ready example.

**Safe ingest targets.** `/demo-shops` serves three fake stores (two with JSON-LD, one plain HTML with no structured data to exercise the fallback parser). When the ingest URL is on the app's own origin under `/demo-shops`, the pages are rendered in-process, so they work on localhost too; every other URL goes through the SSRF-safe fetcher.

**SSRF protection** (`lib/ingest/safe-fetch.ts`, used for every outbound fetch): http and https only, no credentials in the URL, only ports 80, 443, 8080, 8443; localhost and `.local`/`.internal` names refused; the hostname is resolved and every address must be public (private, loopback, link-local, CGNAT, multicast, reserved, IPv6 unique-local and IPv4-mapped/NAT64/6to4 forms are all blocked); the same check runs at connect time to close DNS rebinding; redirects are followed by hand and each hop is re-validated; response capped at 1.5 MB; 8 s budget for the whole chain; text, JSON and CSV content types only.

## Workspaces, chat persistence and limits

There are no accounts. The first API call a browser makes (ingest, publish, chat) sets an httpOnly `ql_ws` cookie holding a random workspace id. Shops you publish belong to that workspace and are invisible to everyone else (pages, buyer chat and conversations all check this); the demo shop is shared. A page can show another of your shops with `?shop=slug`, and the shop switcher does that. Pages cannot set cookies, so a brand-new visitor sees the demo shop until their first API call. Anyone who knows a published shop's MCP URL can use it (that is what a storefront is). Limits: 5 shops per workspace, 200 products per shop.

Buyer chat conversations are stored per workspace and shop (`conversations` and `messages` tables) and mirrored in `localStorage`; a reload restores them (server copy first, local copy if the server has none). A quote or order mentioned in an old message that no longer exists shows "no longer available".

**The demo workspace resets when the server restarts** (the DB is re-seeded on boot); the UI says so in the sidebar and on Setup. A DB file from before multi-shop support is dropped and rebuilt automatically.

Rate limits (in memory, fixed windows, per workspace *and* per IP, HTTP 429 with `Retry-After`; see `lib/ratelimit.ts`): ingest 6 per 10 min per workspace / 12 per IP; publish 10 / 20 per 10 min; chat 60 / 120 per minute; checkout (chat checkout, capture, and the public MCP `create_checkout`) 10 / 20 per minute.

Each PayPal webhook logs one line, `[webhook] type=... signature=ok|failed duplicate=yes|no`, and verified webhooks (including duplicates) appear in the order's audit log on `/checkout/{order}`.

## Deploy on Render

`render.yaml` is a blueprint for one free Node web service (build `npm ci && npm run build`, start `npm run start`, `NODE_VERSION` 22.9.0, DB in `/tmp`). Create a Blueprint from the repo; PayPal and Gemini keys are optional and set in the dashboard. The free tier sleeps when idle, so open the URL once before using it as a connector.

## Layout

- `app/` Next.js App Router pages and the MCP route (`app/m/[shop]/mcp/route.ts`)
- `lib/db.ts`, `lib/schema.ts` SQLite (better-sqlite3), seeded on first open per process
- `lib/seed.ts`, `lib/seed-data.ts`, `scripts/seed.ts` demo state
- `lib/catalog.ts` product search and search logging
- `lib/mcp.ts` per-shop MCP server (stateless, JSON responses)
- `lib/policy.ts`, `lib/quote.ts` deterministic rules and HMAC-signed quotes
- `lib/orders.ts`, `lib/webhook.ts` checkout, capture, order status, webhook receiver
- `lib/chat.ts`, `lib/base-url.ts` buyer chat backend, absolute URL helper
- `lib/config.ts` sim/sandbox mode detection
- `lib/design/tokens.ts` design tokens (colours, type scale, spacing, radii) and the CSS they generate
- `lib/dashboard.ts`, `lib/shop-view.ts` dashboard numbers and shop/catalog loading (per workspace)
- `lib/workspace.ts`, `lib/workspace-server.ts`, `lib/shops.ts` anonymous workspaces, shop creation, visibility rules
- `lib/ingest/` SSRF-safe fetch, JSON-LD / Open Graph extractor, rule-based parser, CSV parser, Gemini normaliser, pipeline, draft validation
- `lib/llm.ts` Gemini over plain fetch with an input-hash cache; `lib/ratelimit.ts` limiter; `lib/conversations.ts` chat persistence
- `lib/demo-shops.ts` the fake stores behind `/demo-shops`
- `components/setup/` Setup screen and the editable review grid
- `components/ui/` Card, Button, Badge, Table, EmptyState, Skeleton, Toast
- `components/shell/` app shell (sidebar, mobile drawer, theme toggle, mode badges)
- `components/catalog/` product cards, card/table catalog view, AG Grid table
- `tests/` Vitest unit tests

## Design system

A warm, woven-textile look: linen neutrals, one indigo accent, "thread" colours for product swatches, Fraunces (display) with Hanken Grotesk (text), both self-hosted through `@fontsource-variable` so there is no network call at runtime. All colours and sizes live in `lib/design/tokens.ts`; `themeCss()` turns them into CSS variables, and `app/globals.css` and the AG Grid theme (`components/catalog/CatalogGrid.tsx`, AG Grid Community) only use those variables. Light and dark follow the OS, and the sidebar toggle saves an explicit choice. A badge in the sidebar always shows **Simulation mode** or **Live sandbox**. Below 860px the sidebar becomes a drawer.

## Status

- [x] Milestone 1 (partial): Next.js + SQLite, seed, demo shop, `search_products` MCP tool, sim mode with no env vars
- [ ] Milestone 1 (remaining): Render deploy, PayPal sandbox order
- [x] Milestone 1b: Render blueprint, PayPal sandbox order (code)
- [x] Milestone 2a: design foundation, app shell, dashboard, catalog with AG Grid
- [x] Milestone 2b: signed quotes, checkout, capture, webhooks, order status, buyer chat
- [x] Milestone 3: multi-shop, anonymous workspaces, URL/CSV ingest with SSRF protection, Setup screen with editable AG Grid, demo shops and sample CSV, chat persistence, rate limits, webhook logging
- [ ] Milestone 4: negotiation, evidence packet, disputes, `get_product`

## License

MIT
