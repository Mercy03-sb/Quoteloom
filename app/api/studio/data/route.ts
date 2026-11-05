import { getDb } from "@/lib/db";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { isStudioTable, studioRows, STUDIO_FIELDS } from "@/lib/studio-data";
import { findVisibleShop, visibleShops, workspaceIdFrom } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rows for the AG Studio dashboard on /studio. Scoped to the caller's workspace (cookie) and to a shop that workspace may see:
// the browser never sends SQL, a workspace id or a shop id, and a slug it may not see is a 404, not a fallback.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  if (!isStudioTable(table)) return Response.json({ error: "bad_table" }, { status: 400 });
  const db = getDb();
  const workspace = workspaceIdFrom(req.headers);
  const ip = clientIp(req.headers);
  const limited = limitResponse(limiter().check("studio_data", { workspace, ip }));
  if (limited) return limited;

  const slug = url.searchParams.get("shop");
  const shop = slug ? findVisibleShop(db, workspace, slug) : visibleShops(db, workspace)[0];
  if (!shop) return Response.json({ error: "unknown_shop" }, { status: 404 });
  const rows = await studioRows(db, shop.id, table, { ip, workspace });
  return Response.json({ table, shop: shop.slug, fields: STUDIO_FIELDS[table], rows }, { headers: { "cache-control": "no-store" } });
}
