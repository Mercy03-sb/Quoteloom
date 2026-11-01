import { z } from "zod";
import { getDb } from "@/lib/db";
import { DisputeError, simulateDispute } from "@/lib/disputes";
import { visibleOrder } from "@/lib/orders-view";
import { clientIp, limiter, limitResponse } from "@/lib/ratelimit";
import { resolveWorkspace, withWorkspaceCookie } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ order_id: z.string().min(1).max(80), reason: z.string().max(60).optional() });

// Demo action: create a SIMULATED dispute on a paid order. Never contacts PayPal.
export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", message: "Send an order_id." }, { status: 400 });
  const db = getDb();
  const ws = resolveWorkspace(db, req.headers);
  const limited = limitResponse(limiter().check("dispute", { workspace: ws.id, ip: clientIp(req.headers) }));
  if (limited) return withWorkspaceCookie(limited, ws);
  if (!visibleOrder(db, ws.id, parsed.data.order_id)) {
    return withWorkspaceCookie(Response.json({ error: "unknown_order", message: "No such order." }, { status: 404 }), ws);
  }
  try {
    const d = simulateDispute(db, parsed.data.order_id, parsed.data.reason);
    return withWorkspaceCookie(Response.json({ dispute_id: d.id, simulated: true }, { status: 201 }), ws);
  } catch (e) {
    if (e instanceof DisputeError) return withWorkspaceCookie(Response.json({ error: e.code, message: e.message }, { status: 409 }), ws);
    throw e;
  }
}
