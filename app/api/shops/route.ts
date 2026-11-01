import { mcpUrl, resolveBaseUrl } from "@/lib/base-url";
import { getDb } from "@/lib/db";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { createShop, ShopError } from "@/lib/shops";
import { resolveWorkspace, withWorkspaceCookie } from "@/lib/workspace";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().min(1).max(120),
  source_url: z.string().max(2048).nullish(),
  products: z.array(z.unknown()).max(1000),
});

function httpUrlOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// Publish a reviewed draft as a new shop in the caller's workspace.
export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", message: "Send a name and products." }, { status: 400 });
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const limited = limitResponse(limiter().check("publish", { workspace: ws.id, ip: clientIp(req.headers) }));
  if (limited) return withWorkspaceCookie(limited, ws);
  try {
    const { shop, products } = createShop(db, ws.id, {
      name: parsed.data.name,
      source_url: httpUrlOrNull(parsed.data.source_url),
      products: parsed.data.products,
    });
    const url = mcpUrl(resolveBaseUrl(req.headers), shop.slug);
    return withWorkspaceCookie(Response.json({ slug: shop.slug, name: shop.name, products, mcp_url: url }, { status: 201 }), ws);
  } catch (e) {
    if (e instanceof ShopError) {
      const status = e.code === "too_many_shops" || e.code === "server_full" ? 409 : 400;
      return withWorkspaceCookie(Response.json({ error: e.code, message: e.message }, { status }), ws);
    }
    throw e;
  }
}
