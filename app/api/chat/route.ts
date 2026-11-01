import { resolveBaseUrl } from "@/lib/base-url";
import type { Shop } from "@/lib/catalog";
import { callShopTool, parseIntent } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("parse"), text: z.string().max(300) }),
  z.object({ action: z.literal("search"), query: z.string().max(200) }),
  z.object({ action: z.literal("quote"), sku: z.string().max(80), qty: z.number().int().min(1).max(1000) }),
  z.object({ action: z.literal("checkout"), quote_id: z.string().max(80) }),
  z.object({ action: z.literal("status"), order_id: z.string().max(80) }),
]);

// Backend for the built-in buyer chat. Every action is one real MCP tool call on the shop.
export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
  const db = getDb();
  const shop = db.prepare("SELECT id, slug, name, source_url FROM shops ORDER BY id LIMIT 1").get() as Shop | undefined;
  if (!shop) return Response.json({ error: "no_shop" }, { status: 404 });
  const base = resolveBaseUrl(req.headers);
  const b = parsed.data;

  if (b.action === "parse") return Response.json({ intent: parseIntent(b.text) });
  if (b.action === "search") return Response.json(await callShopTool(db, shop, "search_products", { query: b.query, limit: 6 }, base));
  if (b.action === "quote") return Response.json(await callShopTool(db, shop, "request_quote", { sku: b.sku, qty: b.qty }, base));
  if (b.action === "checkout") return Response.json(await callShopTool(db, shop, "create_checkout", { quote_id: b.quote_id }, base));
  return Response.json(await callShopTool(db, shop, "get_order_status", { order_id: b.order_id }, base));
}
