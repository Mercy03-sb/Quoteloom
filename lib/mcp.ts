import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { searchProducts, type Shop } from "./catalog";
import type { DB } from "./db";

/** Build an MCP server exposing one shop's tools. */
export function buildShopServer(db: DB, shop: Shop, agentId: string | null): McpServer {
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
      const payload = { shop: shop.slug, query, count: results.length, results };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
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
export async function handleMcpRequest(db: DB, shop: Shop, req: Request): Promise<Response> {
  const server = buildShopServer(db, shop, agentIdFrom(req));
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
