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
- `lib/dashboard.ts`, `lib/shop-view.ts` dashboard numbers and shop/catalog loading
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

## License

MIT
