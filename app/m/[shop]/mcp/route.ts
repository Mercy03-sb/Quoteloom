import { getShop } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { handleMcpRequest } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ shop: string }> };

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
  return handleMcpRequest(db, shop, req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
