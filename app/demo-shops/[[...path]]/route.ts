import { renderDemoShopPage } from "@/lib/demo-shops";

export const dynamic = "force-static";

type Ctx = { params: Promise<{ path?: string[] }> };

// Static fake stores for trying URL ingest safely. See lib/demo-shops.ts.
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { path = [] } = await ctx.params;
  const html = renderDemoShopPage(`/demo-shops/${path.join("/")}`);
  if (html === null) return new Response("Not found", { status: 404 });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
