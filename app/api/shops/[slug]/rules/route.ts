import { getDb } from "@/lib/db";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { ShopError, updateShopRules } from "@/lib/shops";
import { resolveWorkspace, withWorkspaceCookie } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Save a shop's merchant rules. Only the owning workspace may change them; the demo shop is read-only.
export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const body = await req.json().catch(() => null);
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const limited = limitResponse(limiter().check("publish", { workspace: ws.id, ip: clientIp(req.headers) }));
  if (limited) return withWorkspaceCookie(limited, ws);
  try {
    const rules = updateShopRules(db, ws.id, slug, body);
    return withWorkspaceCookie(Response.json({ rules }), ws);
  } catch (e) {
    if (e instanceof ShopError) {
      const status = e.code === "not_found" ? 404 : e.code === "read_only" ? 403 : 400;
      return withWorkspaceCookie(Response.json({ error: e.code, message: e.message }, { status }), ws);
    }
    throw e;
  }
}
