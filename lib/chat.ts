// Built-in buyer chat: a deterministic "buyer agent" that talks to the shop through its real MCP
// tools (in-process). No LLM, no account. The UI shows each tool call and its result.
import type { Shop } from "./catalog";
import type { DB } from "./db";
import { handleMcpRequest } from "./mcp";

export type Intent =
  | { type: "search"; query: string }
  | { type: "quote"; sku: string; qty: number }
  | { type: "checkout" }
  | { type: "status" }
  | { type: "help" };

const SKU_RE = /\b([A-Za-z]{2,}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\b/;

/** Very small, predictable intent parser for the chat box. */
export function parseIntent(text: string): Intent {
  const t = text.trim();
  if (!t || /^(help|\?|hi|hello)$/i.test(t)) return { type: "help" };
  if (/^(buy|checkout|pay|purchase)\b/i.test(t) || /^(yes|ok|okay|go ahead)\b/i.test(t)) return { type: "checkout" };
  if (/^(status|order status|where.?s my order)/i.test(t)) return { type: "status" };
  const sku = SKU_RE.exec(t)?.[1];
  if (sku && /\b(quote|price|buy|want|need|get)\b/i.test(t)) {
    const q = /\b(\d{1,3})\s*(?:x|pcs|units)?\b(?!-)/i.exec(t.replace(sku, " "));
    return { type: "quote", sku: sku.toUpperCase(), qty: q ? Number(q[1]) : 1 };
  }
  const query = t.replace(/^(please\s+)?(find|search( for)?|show me|i('m| am) looking for|looking for|i want|i need)\s+/i, "");
  return { type: "search", query };
}

export type ToolOutcome = { tool: string; args: Record<string, unknown>; isError: boolean; result: Record<string, unknown> };

/** Call one of the shop's MCP tools through the real MCP handler. */
export async function callShopTool(
  db: DB,
  shop: Shop,
  tool: string,
  args: Record<string, unknown>,
  baseUrl: string,
): Promise<ToolOutcome> {
  const req = new Request(`${baseUrl}/m/${shop.slug}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "x-agent-id": "quoteloom-buyer-chat",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const body = (await (await handleMcpRequest(db, shop, req, baseUrl)).json()) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text?: string }[] };
    error?: { message?: string };
  };
  if (body.error || !body.result) {
    return { tool, args, isError: true, result: { error: "mcp_error", message: body.error?.message ?? "Tool call failed." } };
  }
  const structured = body.result.structuredContent ?? { message: body.result.content?.[0]?.text ?? "" };
  return { tool, args, isError: Boolean(body.result.isError), result: structured };
}
