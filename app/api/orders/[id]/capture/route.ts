import { paypalMode } from "@/lib/config";
import { getDb } from "@/lib/db";
import { captureCheckout, OrderError } from "@/lib/orders";
import { simulateCaptureWebhook } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// Called by the checkout page: after PayPal redirects back (sandbox) or after the buyer clicks
// "Approve" on the simulated checkout. Capturing is idempotent.
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const db = getDb();
  try {
    const order = await captureCheckout(db, id);
    if (paypalMode() === "sim") await simulateCaptureWebhook(db, id);
    return Response.json({ order_id: order.id, status: order.status });
  } catch (err) {
    if (err instanceof OrderError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.code === "unknown_order" ? 404 : 409 });
    }
    throw err;
  }
}
