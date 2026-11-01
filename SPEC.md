# Quoteloom: spec

Hackathon: PayPal AI Hackathon (Devpost). Deadline: Nov 12, 2026, 12:00pm PST (about 1:30am IST Nov 13). Target submit: Nov 11.
Judging period: Dec 1 to Dec 15, 2026 (PT). Winners about Dec 21. The project must stay free and unrestricted for testing until judging ends, so everything below must keep working through at least Dec 21.
Prize rules: one project can win at most one Grand/Honorable prize plus ONE sponsor prize. Sponsor prizes exist only for AG Grid, APIMatic, Bryntum, Channel3 and Render. Sponsor tools are optional, PayPal must stay central.

## One-line pitch

Paste a small shop's URL (or upload a CSV). Quoteloom builds an agent-ready storefront: a catalog, merchant rules and a hosted MCP endpoint. Buyer agents search, negotiate, and pay with PayPal sandbox. Each purchase keeps signed-quote evidence for disputes, and the dashboard shows what agents wanted and bought.

## Status (update this section at the end of every session)

- DONE: Milestone 1 core (commit 48cf614). Next.js + TypeScript, SQLite with all spec tables and a seed, one demo shop "Loom & Thread" with 12 products, `search_products` MCP tool at `/m/{shop}/mcp` (plain JSON, no sessions), search logging, 17 tests passing, build passing, runs with no env vars.
- DONE: Milestone 1b code: `render.yaml`, `engines` Node 22, `lib/paypal.ts` (sandbox order via APIMatic Context Plugin, sim fallback), `/api/dev/paypal-test`, 24 tests passing.
- TODO (manual, needs accounts): deploy the blueprint on Render, set sandbox creds, hit `/api/dev/paypal-test` for a real sandbox link, and test the Render MCP URL as a custom connector in Claude Desktop.
- DONE: Milestone 2a, design foundation: `lib/design/tokens.ts` (colours, type scale, spacing, radii, light/dark), app shell with sidebar and mobile drawer, Card/Button/Badge/Table/EmptyState/Skeleton/Toast in `components/ui/`, Simulation/Sandbox badge, dashboard at `/` (shop hero, stats, featured products), `/catalog` with a Cards/Table toggle (AG Grid Community, themed from the tokens), loading/error/not-found states. Fonts self-hosted via `@fontsource-variable` (Fraunces + Hanken Grotesk). New deps: `ag-grid-community`, `ag-grid-react`, two fontsource packages (no accounts). 43 tests passing, build passing. Not yet checked by eye on a real phone/browser.
- NEXT: Milestone 2b: signed quotes (`lib/quote.ts`), policy (`lib/policy.ts`), checkout, capture, webhook receiver, order status, buyer chat and checkout screens. Nav items for later screens are shown as disabled "Soon" entries in `components/shell/nav.ts`; make them real as each ships.

## Hard constraints

- Everything must be free and must keep working through judging (weeks after the deadline).
- One deployable Node service on Render free tier. No Render Postgres, no workers, no cron service.
- SQLite, seeded on every boot. State is disposable.
- Running with NO environment variables must start the full app in simulation mode (no PayPal, no LLM keys).
- Never call the Anthropic API at runtime. Runtime AI is Gemini free tier (Flash-class, model name from env), with a deterministic fallback.
- Fake data only. Sandbox only. No real money, no real customer data.
- Public repo, MIT license, README with one-command local run.
- Pinned versions (do not upgrade without testing on this machine): `better-sqlite3` 12.11.1 (v13 segfaults on Node 22.9 on Windows). Vitest config is `vitest.config.mts`. Set the same Node major on Render (`engines` in package.json or NODE_VERSION).
- If better-sqlite3 ever fails to build, switch to Node's built-in `node:sqlite` (if the Node version supports it) or `sql.js`, keeping the same schema and seed.
- Developer machine: Windows, PowerShell, project at `D:\dev\quoteloom`. C drive is nearly full, so npm cache is on `D:\npm-cache`. Do not add heavy global installs or large caches on C.
- Network: the college LAN blocks the npm registry. `npm install` needs the mobile hotspot. Group dependency additions so installs happen in as few batches as possible. Local dev and tests run offline after install.

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
- In-app scheduler plus a "run sweep" button. On boot, run a catch-up sweep.
- Built-in buyer chat page (works with no Claude account).

## Data model (SQLite)

- shops(id, slug, name, source_url, rules_json)
- products(id, shop_id, sku, title, description, price_cents, currency, stock, attrs_json)
- search_log(id, shop_id, query, results_count, agent_id, ts) -- feeds unmet demand
- quotes(id, shop_id, sku, qty, price_cents, currency, expires_at, signature, transcript_json)
- orders(id, shop_id, quote_id, paypal_order_id, status, amount_cents, created_at, captured_at)
- disputes(id, order_id, paypal_dispute_id, status, evidence_json)
- events(id, type, payload_json, ts) -- webhooks + audit log
- llm_cache(hash, response_json)

## MCP tools (per shop)

- search_products(query, max_price?, limit?) -> logs to search_log
- get_product(sku)
- request_quote(sku, qty, offer_price?) -> deterministic policy; optional LLM-written counter message; returns signed quote
- create_checkout(quote_id) -> verifies signature + expiry, creates PayPal order, returns approval URL
- get_order_status(order_id)

## Key flows

1. Ingest: URL -> fetch HTML/JSON-LD (Playwright only as local fallback) -> normalize to catalog via LLM or parser -> merchant edits in AG Grid -> publish.
2. Shop: buyer agent -> search -> quote -> checkout -> human approves in PayPal -> capture -> webhook -> order PAID.
3. Dispute: webhook or sandbox-created dispute -> assemble evidence packet (request, transcript, signed quote, order) -> merchant approves -> submit via Disputes API (or sim).
4. Unmet demand: group search_log rows with zero or weak results; show in AG Grid with counts.

## Sponsor integration (goal: be eligible for every sponsor prize cheaply, keep working through Dec 21)

Only one sponsor prize can be won, so qualify for several and do each one meaningfully, not superficially.

1. AG Grid (largest sponsor prize). Judged on dashboard polish (custom widgets, theming, layout) and on how it is built (Studio Agent Framework with a custom agent or harness).
   - Start from the hackathon boilerplate: github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate (check its license before copying).
   - Build the analytics dashboard in AG Studio: sales, agent traffic, unmet demand, disputes. Add at least one custom widget and a themed look.
   - Agent Framework: connect Gemini through a custom adapter; add a custom Quoteloom agent/tool (for example "explain this order" or "which searches found nothing").
   - TRIAL TIMING: AG Studio trial is 45 days from when the key is created. Develop without a key first, then create the trial key on Nov 7 or 8 so it lasts past Dec 21. Never commit the key; read it from env at build time.
   - FALLBACK: if Studio fails to initialize or the license is invalid, the dashboard route shows AG Grid Community tables and a static screenshot. Core flows must never depend on Studio.
   - FALLBACK for AI: canned adapter responses for the suggested prompts when Gemini errors or hits quota.
2. Channel3 (must use the API or MCP meaningfully). Free credits via promo code PAYPAL-HACKATHON-2026 (expiry unknown).
   - Use A: market-aware negotiation. Before the seller agent accepts a discount, query Channel3 for the same or similar product price and show it in the quote rationale.
   - Use B: unmet demand. For zero-result searches, fetch Channel3 products and show "consider stocking these" in the dashboard.
   - FALLBACK: store a snapshot of Channel3 responses for all seeded demo queries in the repo and use them when the live call fails or credits run out. The app must work with the key unset.
3. APIMatic (must use the Context Plugin for PayPal while building). Install it into Claude Code in week one and use it to build `lib/paypal.ts`. Record evidence: mention it in commit messages, README tools statement, and the video.
4. Render. The app is deployed on Render (free web service) with a `render.yaml` blueprint committed in the repo. Mention Render in the README and tools statement. Prize criteria are unpublished; ask on the PayPal Discord whether Render Workflows is expected and whether it is free.
5. Bryntum (OPTIONAL, default OFF). Only if Milestone 5 is done by Nov 8: add a Bryntum Scheduler or Calendar showing booked appointments or fulfillment slots for service products. Trial is 45 days. Install it no earlier than Nov 8, check the trial expiry in the package, and skip it if it ends before Dec 21. Never let core flows depend on it.
6. Not used: Elastic, Zapier, KERNEL, Astropods (no prize, trials or credits may expire). Postman: export a free collection of the Quoteloom API into `docs/postman/` as a bonus.

## UI and design (Design is 1 of 5 equally weighted judging criteria; AG Grid prize also judges polish)

Rule: every milestone ships its screens at demo quality, not just the backend. No placeholder-looking pages after Milestone 2.

- Design foundation (build during Milestone 2, before new screens): app shell with sidebar navigation, a design-token file (colours, type scale, spacing, radii), light and dark theme, reusable Card, Button, Table, Badge, EmptyState, Toast components. Distinctive look, not a default template. One AG Grid theme that matches the tokens. Replace the current plain home page with the real dashboard shell.
- Screens: (1) Setup: paste URL or upload CSV, watch the catalog build, publish. (2) Catalog editor (AG Grid). (3) Buyer chat (works with no Claude account; shows tool calls and the signed quote clearly). (4) Checkout and quote view. (5) Orders and disputes with the evidence packet. (6) Analytics dashboard (AG Studio): sales, agent traffic, unmet demand, disputes.
- Every screen needs loading, empty and error states. Mobile width must not break.
- Demo polish pass in Milestone 5, visual check across the whole app in Milestone 6.
- Show the "simulation mode" and "live sandbox" state clearly in the UI so judges are never confused.

## Dev environment notes

- Run Claude Code from the repo root (`D:\dev\quoteloom`). Use one `next dev` server at a time (kill stray ones; Next warns when port 3000 is already in use).
- Claude Desktop custom connectors reach the MCP server from Anthropic's cloud, so `localhost` does not work. Use the Render URL (warm it up first), or locally `npx mcp-remote http://localhost:3000/m/loom-and-thread/mcp`.
- Claude Pro usage is limited (five-hour and weekly). Do not enable usage credits. Work one milestone per session, start fresh sessions with `/clear`, and keep this file current so sessions start fast.

## Milestones

- M1 (core DONE, commit 48cf614): SQLite seed, demo shop, MCP search tool, tests, sim mode.
- M1b: Render deploy, PayPal sandbox order via APIMatic Context Plugin, MCP tool tested from Claude Desktop through the Render URL.
- M2: design foundation (see UI and design), signed quotes, checkout, capture, webhook receiver, order status, with the buyer chat and checkout screens at demo quality.
- M3: ingest from URL/CSV, catalog editor (AG Grid), Setup screen at demo quality.
- M4: negotiation within rules, evidence packet, dispute submit, orders and disputes screens at demo quality.
- M5: AG Studio dashboard + Agent Framework, Channel3 integration with snapshot fallback, full visual polish pass (states, theme, mobile), hardening (no-key run, cold start, Gemini failure, PayPal failure, Channel3 failure, Studio license failure).
- M6: README, video, Devpost submission.

Cut order if late: URL ingest (keep CSV) -> negotiation -> dispute packet. Never cut: MCP endpoint, signed quotes, checkout, dashboard.

## Acceptance tests

- `npm install && npm run dev` with no env vars: app starts, seeded shop visible, buyer chat can search, quote and complete a simulated checkout.
- With sandbox creds: a real sandbox order is created and captured.
- Tampered or expired quote is rejected by create_checkout.
- Gemini failure/429: falls back, app still works.
- Restart wipes the DB: the seed restores the demo with no manual steps.
