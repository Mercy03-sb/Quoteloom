import { getDb } from "@/lib/db";
import { approveAndSubmit, DisputeError, loadDispute } from "@/lib/disputes";
import { visibleOrder } from "@/lib/orders-view";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { resolveWorkspace, withWorkspaceCookie } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The merchant approved the evidence packet: submit it (Disputes API in sandbox, or simulated).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const limited = limitResponse(limiter().check("dispute", { workspace: ws.id, ip: clientIp(req.headers) }));
  if (limited) return withWorkspaceCookie(limited, ws);
  const d = loadDispute(db, id);
  if (!d || !visibleOrder(db, ws.id, d.order_id)) {
    return withWorkspaceCookie(Response.json({ error: "unknown_dispute", message: "No such dispute." }, { status: 404 }), ws);
  }
  try {
    const r = await approveAndSubmit(db, id);
    return withWorkspaceCookie(Response.json({ status: r.dispute.status, mode: r.submission.mode, simulated: r.dispute.simulated === 1 }), ws);
  } catch (e) {
    if (e instanceof DisputeError) {
      return withWorkspaceCookie(Response.json({ error: e.code, message: e.message }, { status: e.code === "submit_failed" ? 502 : 409 }), ws);
    }
    throw e;
  }
}
