import { devRoutesEnabled, paypalMode } from "@/lib/config";
import { createOrder, PaypalError } from "@/lib/paypal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dev check: creates a PayPal sandbox order (or a simulated one) and returns the approval link.
export async function GET(req: Request): Promise<Response> {
  if (!devRoutesEnabled()) return new Response("Not found", { status: 404 });
  const origin = new URL(req.url).origin;
  try {
    const order = await createOrder({
      amountCents: 1999,
      description: "Quoteloom sandbox test order",
      referenceId: "dev-paypal-test",
      returnUrl: `${origin}/api/dev/paypal-test`,
      cancelUrl: `${origin}/api/dev/paypal-test`,
    });
    return Response.json(order);
  } catch (err) {
    const e = err as PaypalError;
    return Response.json(
      { mode: paypalMode(), error: e.message },
      { status: e.statusCode && e.statusCode >= 400 ? 502 : 500 },
    );
  }
}
