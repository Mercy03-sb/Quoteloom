# Quoteloom: spec

Hackathon: PayPal AI Hackathon (Devpost). Deadline: Nov 12, 2026, 12:00pm PST (about 1:30am IST Nov 13). Target submit: Nov 11.
Judging period: Dec 1 to Dec 15, 2026 (PT). Winners about Dec 21. The project must stay free and unrestricted for testing until judging ends, so everything below must keep working through at least Dec 21.
Prize rules: one project can win at most one Grand/Honorable prize plus ONE sponsor prize. Sponsor prizes exist only for AG Grid, APIMatic, Bryntum, Channel3 and Render. Sponsor tools are optional, PayPal must stay central.

## One-line pitch

Paste a small shop's URL (or upload a CSV). Quoteloom builds an agent-ready storefront: a catalog, merchant rules and a hosted MCP endpoint. Buyer agents search, negotiate, and pay with PayPal sandbox. Each purchase keeps signed-quote evidence for disputes, and the dashboard shows what agents wanted and bought.

## Status (update this section at the end of every session)

- DONE: Milestone 1 core (commit 48cf614). Next.js + TypeScript, SQLite with all spec tables and a seed, one demo shop "Loom & Thread" with 12 products, `search_products` MCP tool at `/m/{shop}/mcp` (plain JSON, no sessions), search logging, runs with no env vars.
- DONE: Milestone 1b: `render.yaml`, `engines` Node 22, `lib/paypal.ts` (sandbox order via the APIMatic Context Plugin, sim fallback), `/api/dev/paypal-test`. Deployed on Render free tier at https://quoteloom.onrender.com. MCP endpoint tested as a custom connector in Claude Desktop (search_products returns correct results). Real sandbox order created with US sandbox accounts (India-region sandbox accounts rejected USD).
- DONE: Milestone 2a, design foundation: `lib/design/tokens.ts` (colours, type scale, spacing, radii, light/dark), app shell with sidebar and mobile drawer, Card/Button/Badge/Table/EmptyState/Skeleton/Toast in `components/ui/`, Simulation/Sandbox badge, dashboard at `/` (shop hero, stats, featured products), `/catalog` with a Cards/Table toggle (AG Grid Community, themed from the tokens), loading/error/not-found states. Fonts self-hosted via `@fontsource-variable` (Fraunces + Hanken Grotesk). 2a review fixes done: hero shows the absolute MCP URL (request host, else `NEXT_PUBLIC_BASE_URL`), Copy URL copies it, per-product woven pattern and colour (`lib/design/weave.ts`), one filter icon per AG Grid column, sidebar note wraps.
- DONE: Milestone 2b: `lib/policy.ts` (rules parsed, quantity/stock checks, list price only, no negotiation yet), `lib/quote.ts` (HMAC-SHA256, 10 min expiry, quote id is the nonce, `QUOTE_SIGNING_SECRET` or random per-process secret), `lib/orders.ts` (create checkout, capture, forward-only status), `lib/webhook.ts` + `POST /api/webhooks/paypal` (signature verified: PayPal verify API in sandbox, HMAC in sim; dedupe by event id), `captureOrder`/`verifyWebhook` in `lib/paypal.ts`. MCP tools `request_quote`, `create_checkout`, `get_order_status`. Screens: `/chat`, `/quote/{id}`, `/checkout/{order}`. `/api/dev/*` is 404 in production unless `ALLOW_DEV_ROUTES=1`. ChatClient useEffect crash fixed (commit 9467186) with a regression test.
- VERIFIED LIVE (Nov 1): full sandbox purchase on Render: quote -> PayPal approval with the US sandbox buyer -> capture -> order PAID, audit log and signed-quote page showing "Signature valid". PayPal webhook events (CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED) delivered with Success status. Render env vars set: DATABASE_PATH, NODE_VERSION, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, QUOTE_SIGNING_SECRET.
- Known limits: stock is taken on payment, not reserved at checkout, so two buyers can race (the later capture is blocked only by a pre-capture stock check); one order per quote; `get_product` MCP tool not built yet; `source_url` on the demo shop stays null (it is seeded, not ingested); LLM mode is "fallback" until `GEMINI_API_KEY` is set.
- DONE: Milestone 3 (no new dependencies). Multi-shop (`shops.workspace_id`, null = shared demo shop); anonymous workspaces (`ql_ws` httpOnly cookie, set by the first API call, `lib/workspace.ts`; pages read it, only route handlers issue it); ingest pipeline `lib/ingest/` (SSRF-safe fetch, JSON-LD then Open Graph, Gemini via plain fetch only when a site has no structured data, rule-based fallback, CSV, draft validation); `lib/llm.ts` (Gemini, cached in `llm_cache` by input hash, 60 s cooldown after 429); `POST /api/ingest` streams NDJSON steps, `POST /api/shops` publishes; Setup screen `/setup` with editable AG Grid review, publish, MCP URL + copy; fake stores under `/demo-shops` (rendered in-process when ingesting the app's own origin) and `public/sample-products.csv`; chat persistence (`/api/conversation`, localStorage mirror, "no longer available" for reset quotes/orders); rate limits (`lib/ratelimit.ts`, workspace + IP, ingest/publish/chat/checkout incl. MCP `create_checkout`); `[webhook] type=.. signature=.. duplicate=..` console line, duplicates and verified webhooks shown in the order audit log; sidebar and Setup note that the demo workspace resets on restart. Old DB files without `workspace_id` are dropped and rebuilt on open.
- Known limits (M3): the active shop is chosen by `?shop=` (default: newest own shop, else demo), not stored; a first-time visitor has no cookie until their first API call; rate limiter is in memory (resets on restart, not shared across instances); `/api/webhooks/paypal` is not rate limited (PayPal needs it and it is signature checked); grid cell editing, outlines and the Setup layout at phone width were not opened in a real browser (see session report); ingested products get stock 10 unless the page says out of stock; new shops have negotiation off.
- NEXT: Milestone 4 (negotiation within rules, evidence packet, dispute submit, orders and disputes screens, `get_product` tool). Nav items for later screens are disabled "Soon" entries in `components/shell/nav.ts`.
- MANUAL TODO: add `GEMINI_API_KEY` locally and on Render; get a Channel3 key (`trychannel3.com/developers`, promo PAYPAL-HACKATHON-2026) for Milestone 5; create the AG Studio trial key on Nov 7 or 8, not before.

## Hard constraints

- Everything must be free and must keep working through judging (weeks after the deadline).
- One deployable Node service on Render free tier. No Render Postgres, no workers, no cron service.
- SQLite, seeded on every boot. State is disposable; the UI says so.
- Running with NO environment variables must start the full app in simulation mode (no PayPal, no LLM keys).
- Never call the Anthropic API at runtime. Runtime AI is Gemini free tier (Flash-class, model name from env), with a deterministic fallback.
- Fake data only. Sandbox only. No real money, no real customer data.
- No login and no accounts. Visitors get anonymous workspaces (random ID in an httpOnly cookie). Real auth is listed as future work in the README only.
- Public endpoints that cost something (Gemini, URL fetch, order creation) must be rate limited per workspace and per IP.
- Public repo, MIT license, README with one-command local run.
- Pinned versions (do not upgrade without testing on this machine): `better-sqlite3` 12.11.1 (v13 segfaults on Node 22.9 on Windows). Vitest config is `vitest.config.mts`. Test DOM environment is happy-dom (jsdom does not load on Node 22.9). Set the same Node major on Render (`engines` in package.json or NODE_VERSION).
- If better-sqlite3 ever fails to build, switch to Node's built-in `node:sqlite` (if the Node version supports it) or `sql.js`, keeping the same schema and seed.
- Developer machine: Windows, PowerShell, project at `D:\dev\quoteloom`. C drive is nearly full, so npm cache is on `D:\npm-cache`. Do not add heavy global installs or large caches on C.
- Network: the college LAN blocks the npm registry. `npm install` needs the mobile hotspot. Group dependency additions so installs happen in as few batches as possible, and say which packages are needed before installing. Local dev and tests run offline after install.
- Never start a prompt to Claude Code with a slash unless it is a real command; a route like /chat is read as a command.

## Architecture (single service)

- Next.js (App Router, TypeScript): dashboard UI + API routes.
- AG Grid Community for catalog editor, orders, disputes tables (free, permanent, always works).
- AG Studio (Enterprise, 45-day free trial) for the analytics dashboard plus the Studio Agent Framework with a Gemini adapter. See Sponsor section for trial timing and fallbacks.
- `lib/channel3.ts`: Channel3 API client with a snapshot cache (see Sponsor section).
- MCP endpoint per shop at `/m/{shop}/mcp` (Streamable HTTP), plus `/m/{shop}/llms.txt` and `/m/{shop}/agent.json`.
- `lib/llm.ts`: provider interface. Gemini first, then deterministic fallback. Cache responses by input hash in SQLite.
- `lib/paypal.ts`: PayPal REST (sandbox), Orders v2 create/capture, webhook signature verification, Disputes evidence. Has `PAYPAL_MODE=sim|sandbox`. Default `sim` when credentials are missing.
- `lib/quote.ts`: HMAC-signed price commitments (shop, sku, qty, price, currency, expiry, nonce).
- `lib/policy.ts`: deterministic merchant rules (min margin, max discount, negotiation on/off). The LLM may propose, this code decides.
- `lib/db.ts` + `scripts/seed.ts`: SQLite and a seed that recreates the demo state.
- `lib/workspace.ts`: anonymous workspace cookie and per-workspace scoping of shops and conversations.
- `lib/ratelimit.ts`: simple per-workspace and per-IP limiter (in memory is fine).
- `lib/ingest/`: fetchers (SSRF-safe), JSON-LD / Open Graph extractor, CSV parser, LLM normaliser with rule-based fallback.
- In-app scheduler plus a "run sweep" button. On boot, run a catch-up sweep.
- Built-in buyer chat page (works with no Claude account); conversations persist per workspace.

## Data model (SQLite)

- workspaces(id, created_at)
- shops(id, slug, name, source_url, rules_json, workspace_id) -- workspace_id null means the shared demo shop
- products(id, shop_id, sku, title, description, price_cents, currency, stock, attrs_json)
- search_log(id, shop_id, query, results_count, agent_id, ts) -- feeds unmet demand
- quotes(id, shop_id, sku, qty, price_cents, currency, expires_at, signature, transcript_json)
- orders(id, shop_id, quote_id, paypal_order_id, status, amount_cents, created_at, captured_at)
- disputes(id, order_id, paypal_dispute_id, status, evidence_json)
- events(id, type, payload_json, ts) -- webhooks + audit log
- conversations(id, workspace_id, shop_id, created_at) and messages(id, conversation_id, role, content_json, ts)
- llm_cache(hash, response_json)

## MCP tools (per shop)

- search_products(query, max_price?, limit?) -> logs to search_log
- get_product(sku)
- request_quote(sku, qty, offer_price?) -> deterministic policy; optional LLM-written counter message; returns signed quote
- create_checkout(quote_id) -> verifies signature + expiry, creates PayPal order, returns approval URL
- get_order_status(order_id)

## Key flows

1. Ingest: URL -> SSRF-safe fetch of the page plus up to 20 linked product pages on the same origin -> extract from JSON-LD and Open Graph first -> Gemini only as a fallback to normalise messy HTML (cached by input hash), rule-based parser if no key or failure -> merchant edits the draft in AG Grid -> publish -> shop MCP URL. CSV upload follows the same draft/review/publish path. (Playwright only as a local fallback.)
2. Shop: buyer agent -> search -> quote -> checkout -> human approves in PayPal -> capture -> webhook -> order PAID.
3. Dispute: webhook or sandbox-created dispute -> assemble evidence packet (request, transcript, signed quote, order) -> merchant approves -> submit via Disputes API (or sim).
4. Unmet demand: group search_log rows with zero or weak results; show in AG Grid with counts.

## Security and abuse limits

- SSRF protection on every outbound fetch: http and https only, block private, loopback and link-local ranges (also after DNS resolution and redirects), response size cap, timeout. Show a notice to ingest only sites you own or have permission to use.
- Rate limits per workspace and per IP on ingest, chat and checkout endpoints. Cache LLM results.
- Dev routes disabled in production unless `ALLOW_DEV_ROUTES=1`.
- Webhooks rejected unless the signature verifies (sandbox needs `PAYPAL_WEBHOOK_ID`).
- Never log secrets. Never commit `.env.local`.

## Sponsor integration (goal: be eligible for every sponsor prize cheaply, keep working through Dec 21)

Only one sponsor prize can be won, so qualify for several and do each one meaningfully, not superficially.

1. AG Grid (largest sponsor prize). Judged on dashboard polish (custom widgets, theming, layout) and on how it is built (Studio Agent Framework with a custom agent or harness).
   - Start from the hackathon boilerplate: github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate (check its license before copying).
   - Build the analytics dashboard in AG Studio: sales, agent traffic, unmet demand, disputes. Add at least one custom widget and a themed look.
   - Agent Framework: connect Gemini through a custom adapter; add a custom Quoteloom agent/tool (for example "explain this order" or "which searches found nothing").
   - TRIAL TIMING: AG Studio trial is 45 days from when the key is created. Develop without a key first, then create the trial key on Nov 7 or 8 so it lasts past Dec 21. Never commit the key; read it from env at build time.
   - FALLBACK: if Studio fails to initialize or the license is invalid, the dashboard route shows AG Grid Community tables and a static screenshot. Core flows must never depend on Studio.
   - FALLBACK for AI: canned adapter responses for the suggested prompts when Gemini errors or hits quota.
2. Channel3 (must use the API or MCP meaningfully). Free credits via promo code PAYPAL-HACKATHON-2026 (20,000 searches; the sponsor says the app stays live and they top up on request in their Discord channel).
   - Use A: market-aware negotiation. Before the seller agent accepts a discount, query Channel3 for the same or similar product price and show it in the quote rationale.
   - Use B: unmet demand. For zero-result searches, fetch Channel3 products and show "consider stocking these" in the dashboard.
   - FALLBACK: store a snapshot of Channel3 responses for all seeded demo queries in the repo and use them when the live call fails or credits run out. The app must work with the key unset. Cache live responses so judge traffic does not spend credits.
3. APIMatic (must use the Context Plugin for PayPal while building). Plugin is installed in Claude Code (PayPal, 48 skills). Used for `lib/paypal.ts`. Record evidence: mention it in commit messages, README tools statement, and the video. Claim form (after the repo is public and shows usage): see the hackathon APIMatic page.
4. Render. The app is deployed on Render (free web service) with a `render.yaml` blueprint committed in the repo. Mention Render in the README and tools statement. Prize criteria are unpublished; ask on the PayPal Discord whether Render Workflows is expected and whether it is free.
5. Bryntum (OPTIONAL, default OFF). Only if Milestone 5 is done by Nov 8: add a Bryntum Scheduler or Calendar showing booked appointments or fulfillment slots for service products. Trial is 45 days. Install it no earlier than Nov 8, check the trial expiry in the package, and skip it if it ends before Dec 21. Never let core flows depend on it.
6. Not used: Elastic, Zapier, KERNEL, Astropods (no prize, trials or credits may expire). Postman: export a free collection of the Quoteloom API into `docs/postman/` as a bonus.

## UI and design (Design is 1 of 5 equally weighted judging criteria; AG Grid prize also judges polish)

Rule: every milestone ships its screens at demo quality, not just the backend. No placeholder-looking pages. Every new page must be rendered in a test, and any page not opened in a real browser must be called out in the session report.

- Design foundation is built (M2a): tokens, shell, components, themes. New screens must reuse it.
- Screens: (1) Setup: paste URL or upload CSV, watch the catalog build, publish. (2) Catalog editor (AG Grid). (3) Buyer chat (works with no Claude account; shows tool calls and the signed quote clearly; conversation survives reload). (4) Checkout and quote view. (5) Orders and disputes with the evidence packet. (6) Analytics dashboard (AG Studio): sales, agent traffic, unmet demand, disputes.
- Every screen needs loading, empty and error states. Mobile width must not break.
- Demo polish pass in Milestone 5, visual check across the whole app in Milestone 6.
- Show the "simulation mode" and "live sandbox" state clearly in the UI so judges are never confused.
- Show a clear note that the demo workspace resets when the server restarts.

## Dev environment notes

- Run Claude Code from the repo root (`D:\dev\quoteloom`). Use one `next dev` server at a time (kill stray ones; Next warns when port 3000 is already in use).
- Claude Desktop custom connectors reach the MCP server from Anthropic's cloud, so `localhost` does not work. Use the Render URL (warm it up first), or locally `npx mcp-remote http://localhost:3000/m/loom-and-thread/mcp`.
- Claude Pro usage is limited (five-hour and weekly). Do not enable usage credits. Use Sonnet for routine work. Work one milestone per session, start fresh sessions with `/clear`, and keep this file current so sessions start fast.

## Milestones and schedule

- M1 (DONE): SQLite seed, demo shop, MCP search tool, tests, sim mode.
- M1b (DONE): Render deploy, PayPal sandbox order via APIMatic Context Plugin, MCP tool tested from Claude Desktop through the Render URL.
- M2 (DONE, 2a + 2b): design foundation, signed quotes, checkout, capture, webhook receiver, order status, buyer chat and checkout screens. Verified live with a real sandbox purchase and webhooks.
- M3 (DONE Nov 1): multi-shop, anonymous workspaces, ingest from URL/CSV with SSRF protection, catalog editor (AG Grid), Setup screen at demo quality, demo shop pages and sample CSV, chat persistence, rate limits, webhook receipt logging and audit-log display.
- M4 (Nov 4-5): negotiation within rules, evidence packet, dispute submit, orders and disputes screens at demo quality, `get_product` tool.
- M5 (Nov 6-8): AG Studio dashboard + Agent Framework (create the trial key on Nov 7 or 8), Channel3 integration with snapshot fallback, full visual polish pass (states, theme, mobile), hardening (no-key run, cold start, Gemini failure, PayPal failure, Channel3 failure, Studio license failure).
- M6 (Nov 9-11): README with tools statement, record the demo video (under 3 minutes, YouTube public), Devpost submission. Nov 12 is buffer.
  Cut order if late: URL ingest (keep CSV) -> negotiation -> dispute packet. Never cut: MCP endpoint, signed quotes, checkout, dashboard.

## Acceptance tests

- `npm install && npm run dev` with no env vars: app starts, seeded shop visible, buyer chat can search, quote and complete a simulated checkout.
- With sandbox creds: a real sandbox order is created and captured (verified Nov 1).
- Tampered or expired quote is rejected by create_checkout.
- Gemini failure/429: falls back, app still works.
- Channel3 key unset or failing: app still works using snapshots.
- AG Studio license missing or invalid: dashboard falls back to AG Grid Community tables.
- Restart wipes the DB: the seed restores the demo with no manual steps.
- A shop ingested from /demo-shops and from the sample CSV can be published and searched through its MCP URL.
- SSRF cases are rejected (localhost, private ranges, non-http schemes, redirects to private IPs).
- A page reload restores the buyer chat conversation; a missing quote shows a "no longer available" state.
