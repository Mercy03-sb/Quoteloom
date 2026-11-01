import { getDb } from "@/lib/db";
import { handlePaypalWebhook } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PayPal webhook receiver. The raw body is needed for signature verification, so do not parse it first.
export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 256 * 1024) return Response.json({ error: "too_large" }, { status: 413 });
  const result = await handlePaypalWebhook(getDb(), raw, req.headers);
  return Response.json(result.body, { status: result.status });
}
