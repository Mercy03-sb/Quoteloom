import { resolveBaseUrl } from "@/lib/base-url";
import { callShopTool, parseIntent } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { findVisibleShop, resolveWorkspace, withWorkspaceCookie } from "@/lib/workspace";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shop = z.string().min(1).max(80);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("parse"), shop: shop.optional(), text: z.string().max(300) }),
  z.object({ action: z.literal("search"), shop, query: z.string().max(200) }),
  z.object({ action: z.literal("quote"), shop, sku: z.string().max(80), qty: z.number().int().min(1).max(1000) }),
  z.object({ action: z.literal("checkout"), shop, quote_id: z.string().max(80) }),
  z.object({ action: z.literal("status"), shop, order_id: z.string().max(80) }),
]);

// Backend for the built-in buyer chat. Every action is one real MCP tool call on the shop.
// Limited per workspace and per IP; checkout has its own tighter bucket on top of the chat one.
export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
  const b = parsed.data;
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const ids = { workspace: ws.id, ip: clientIp(req.headers) };
  const reply = (body: unknown, status = 200) => withWorkspaceCookie(Response.json(body, { status }), ws);

  const limited = limitResponse(limiter().check("chat", ids)) ?? (b.action === "checkout" ? limitResponse(limiter().check("checkout", ids)) : null);
  if (limited) return withWorkspaceCookie(limited, ws);

  if (b.action === "parse") return reply({ intent: parseIntent(b.text) });
  const found = findVisibleShop(db, ws.id, b.shop);
  if (!found) return reply({ error: "unknown_shop" }, 404);
  const base = resolveBaseUrl(req.headers);

  if (b.action === "search") return reply(await callShopTool(db, found, "search_products", { query: b.query, limit: 6 }, base));
  if (b.action === "quote") return reply(await callShopTool(db, found, "request_quote", { sku: b.sku, qty: b.qty }, base));
  if (b.action === "checkout") return reply(await callShopTool(db, found, "create_checkout", { quote_id: b.quote_id }, base));
  return reply(await callShopTool(db, found, "get_order_status", { order_id: b.order_id }, base));
}
