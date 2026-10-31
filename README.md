# Quoteloom

Agent-ready storefronts for small shops: a catalog, merchant rules and a hosted MCP endpoint that buyer agents can search, negotiate with and (later) pay through PayPal sandbox. See [SPEC.md](SPEC.md).

Fake data only. Sandbox only. No real money.

## Run locally

Requires Node 20.9+ (tested on Node 22).

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

Tools available so far:

- `search_products(query, max_price?, limit?)`: keyword search over the shop catalog. `max_price` is in major units (e.g. `50` = $50.00). Every search, including zero-result ones, is logged to `search_log`.

Quick check with curl:

```bash
curl -s http://localhost:3000/m/loom-and-thread/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"merino scarf"}}}'
```

To use it from Claude Desktop, add it as a remote MCP server. Claude Desktop reaches it only over a public HTTPS URL (for example the Render deploy), or locally through a bridge such as `npx mcp-remote http://localhost:3000/m/loom-and-thread/mcp`.

## Layout

- `app/` Next.js App Router pages and the MCP route (`app/m/[shop]/mcp/route.ts`)
- `lib/db.ts`, `lib/schema.ts` SQLite (better-sqlite3), seeded on first open per process
- `lib/seed.ts`, `lib/seed-data.ts`, `scripts/seed.ts` demo state
- `lib/catalog.ts` product search and search logging
- `lib/mcp.ts` per-shop MCP server (stateless, JSON responses)
- `lib/config.ts` sim/sandbox mode detection
- `tests/` Vitest unit tests

## Status

- [x] Milestone 1 (partial): Next.js + SQLite, seed, demo shop, `search_products` MCP tool, sim mode with no env vars
- [ ] Milestone 1 (remaining): Render deploy, PayPal sandbox order
- [ ] Milestone 2: signed quotes, checkout, capture, webhooks, order status

## License

MIT
