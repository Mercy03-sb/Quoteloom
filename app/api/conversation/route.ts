import { findMissingRefs, loadConversation, sanitizeMessages, saveConversation } from "@/lib/conversations";
import { getDb } from "@/lib/db";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { findVisibleShop, resolveWorkspace, withWorkspaceCookie } from "@/lib/workspace";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Buyer-chat persistence per workspace. GET restores; PUT stores the whole message list and
// reports which quotes/orders referenced by old messages no longer exist.
export async function GET(req: Request): Promise<Response> {
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const limited = limitResponse(limiter().check("chat", { workspace: ws.id, ip: clientIp(req.headers) }));
  if (limited) return limited;
  const shop = findVisibleShop(db, ws.id, new URL(req.url).searchParams.get("shop") ?? "");
  if (!shop) return withWorkspaceCookie(Response.json({ error: "unknown_shop" }, { status: 404 }), ws);
  const messages = loadConversation(db, ws.id, shop.id);
  return withWorkspaceCookie(Response.json({ messages, missing: findMissingRefs(db, shop.id, messages) }), ws);
}

const Put = z.object({ shop: z.string().min(1).max(80), messages: z.array(z.unknown()).max(1000) });

export async function PUT(req: Request): Promise<Response> {
  const parsed = Put.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const limited = limitResponse(limiter().check("chat", { workspace: ws.id, ip: clientIp(req.headers) }));
  if (limited) return limited;
  const shop = findVisibleShop(db, ws.id, parsed.data.shop);
  if (!shop) return withWorkspaceCookie(Response.json({ error: "unknown_shop" }, { status: 404 }), ws);
  const messages = sanitizeMessages(parsed.data.messages);
  saveConversation(db, ws.id, shop.id, messages);
  return withWorkspaceCookie(Response.json({ saved: messages.length, missing: findMissingRefs(db, shop.id, messages) }), ws);
}
