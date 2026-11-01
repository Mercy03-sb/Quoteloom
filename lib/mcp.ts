import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { resolveBaseUrl } from "./base-url";
import { getProduct, searchProducts, type Shop } from "./catalog";
import type { DB } from "./db";
import { createCheckout, getOrderStatus, OrderError } from "./orders";
import { PaypalError } from "./paypal";
import { PolicyError } from "./policy";
import { issueQuoteDrafted, QuoteError } from "./quote";

const money = (cents: number) => (cents / 100).toFixed(2);

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

/** Expected business failures become tool errors the agent can read; anything else is rethrown. */
function fail(err: unknown): ToolResult {
  if (err instanceof PolicyError || err instanceof QuoteError || err instanceof OrderError || err instanceof PaypalError) {
    const code = "code" in err ? String(err.code) : "paypal_error";
    const payload = { error: code, message: err.message };
    return { ...ok(payload), isError: true };
  }
  throw err;
}

/** Build an MCP server exposing one shop's tools. */
export function buildShopServer(db: DB, shop: Shop, agentId: string | null, baseUrl = resolveBaseUrl()): McpServer {
  const server = new McpServer({ name: `quoteloom-${shop.slug}`, version: "0.1.0" });

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: `Search the ${shop.name} catalog by keywords. Prices are decimal amounts in the product currency.`,
      inputSchema: {
        query: z.string().max(200).describe("Keywords, e.g. 'wool scarf'. Empty string lists everything."),
        max_price: z.number().nonnegative().optional().describe("Only return products at or below this price."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ query, max_price, limit }) => {
      const results = searchProducts(db, shop, { query, max_price, limit }, agentId);
      return ok({ shop: shop.slug, query, count: results.length, results });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get one product",
      description: `Full details of one ${shop.name} product by SKU: description, attributes, price, stock and the shop's quantity discounts. Use request_quote to buy.`,
      inputSchema: { sku: z.string().min(1).max(80).describe("SKU from search_products.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sku }) => {
      const p = getProduct(db, shop, sku);
      if (!p) return { ...ok({ error: "unknown_sku", message: `No product with SKU ${sku}.` }), isError: true };
      return ok({ shop: shop.slug, product: p });
    },
  );

  server.registerTool(
    "request_quote",
    {
      title: "Request a signed quote",
      description:
        "Get a price commitment for a SKU and quantity. The shop's rules set the price, not the caller. " +
        "You may add offer_price (per unit) to negotiate: the shop accepts it, counters with the best price it can do, or " +
        "declines to negotiate, always within its own limits. Quantity discounts may apply. " +
        "The quote is signed and valid for 10 minutes; pass quote_id to create_checkout to buy it.",
      inputSchema: {
        sku: z.string().min(1).max(80).describe("SKU from search_products."),
        qty: z.number().int().min(1).max(1000).describe("Quantity (whole number)."),
        offer_price: z.number().positive().optional().describe("Optional unit price you would like to pay (decimal, in the product currency). The shop decides within its rules."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ sku, qty, offer_price }) => {
      try {
        const q = await issueQuoteDrafted(db, shop, {
          sku,
          qty,
          offerCents: offer_price === undefined ? undefined : Math.round(offer_price * 100),
          agentId,
        });
        return ok({
          quote_id: q.id,
          sku: q.sku,
          title: q.title,
          qty: q.qty,
          unit_price: money(q.price_cents),
          total: money(q.total_cents),
          currency: q.currency,
          expires_at: q.expires_at,
          signature: q.signature,
          negotiation: {
            outcome: q.outcome,
            list_price: money(q.list_price_cents),
            offered: offer_price === undefined ? null : money(Math.round(offer_price * 100)),
            final_unit_price: money(q.price_cents),
            reasons: q.public_reasons,
          },
          list_price: money(q.list_price_cents),
          quantity_discounts: q.quantity_discounts,
          message: q.message,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_checkout",
    {
      title: "Create a PayPal checkout",
      description:
        "Turn a valid, unexpired quote into a PayPal sandbox order. Returns an approval_url that a human must open to pay. " +
        "Then poll get_order_status. A quote can be used once.",
      inputSchema: { quote_id: z.string().min(1).max(80).describe("quote_id from request_quote.") },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ quote_id }) => {
      try {
        const c = await createCheckout(db, shop, quote_id, baseUrl);
        return ok({
          order_id: c.order_id,
          status: c.status,
          total: money(c.amount_cents),
          currency: c.currency,
          approval_url: c.approval_url,
          mode: c.mode === "sim" ? "simulation" : "paypal_sandbox",
          message: "Ask the buyer to open approval_url and approve the payment, then call get_order_status.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description: "Status of an order from create_checkout: CREATED, APPROVED, PAID, FAILED or REFUNDED.",
      inputSchema: { order_id: z.string().min(1).max(80).describe("order_id from create_checkout.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ order_id }) => {
      try {
        return ok({ ...getOrderStatus(db, shop, order_id) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

/** Identify the calling agent for search_log. Best effort, never trusted for decisions. */
export function agentIdFrom(req: Request): string | null {
  const id = req.headers.get("x-agent-id") ?? req.headers.get("user-agent");
  return id ? id.slice(0, 120) : null;
}

/**
 * Handle one Streamable HTTP request statelessly: a fresh server + transport per
 * request, JSON responses (no long-lived SSE), which suits a single free-tier service.
 */
export async function handleMcpRequest(db: DB, shop: Shop, req: Request, baseUrl?: string): Promise<Response> {
  const server = buildShopServer(db, shop, agentIdFrom(req), baseUrl ?? resolveBaseUrl(req.headers));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
