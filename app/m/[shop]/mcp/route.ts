import { getShop } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { handleMcpRequest } from "@/lib/mcp";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ shop: string }> };

/** True when the JSON-RPC body calls create_checkout. Reads a clone so the MCP transport still gets the body. */
async function isCheckoutCall(req: Request): Promise<boolean> {
  if (req.method !== "POST") return false;
  const body = (await req.clone().json().catch(() => null)) as unknown;
  const calls = Array.isArray(body) ? body : [body];
  return calls.some((c) => {
    const m = c as { method?: string; params?: { name?: string } } | null;
    return m?.method === "tools/call" && m.params?.name === "create_checkout";
  });
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { shop: slug } = await ctx.params;
  const db = getDb();
  const shop = getShop(db, slug);
  if (!shop) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: `Unknown shop: ${slug}` }, id: null },
      { status: 404 },
    );
  }
  if (await isCheckoutCall(req)) {
    // Outside agents have no workspace; they are limited per IP. Creating orders is the costly call.
    const limited = limitResponse(limiter().check("checkout", { workspace: null, ip: clientIp(req.headers) }));
    if (limited) return limited;
  }
  return handleMcpRequest(db, shop, req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
