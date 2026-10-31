// PayPal Orders v2 (sandbox). Written with the APIMatic Context Plugin for PayPal
// (@paypal/paypal-server-sdk). With no credentials, everything runs in simulation.
import {
  ApiError,
  Client,
  CheckoutPaymentIntent,
  Environment,
  OrdersController,
} from "@paypal/paypal-server-sdk";
import { paypalMode, type PaypalMode } from "@/lib/config";

type Env = Record<string, string | undefined>;

export type CreateOrderInput = {
  amountCents: number;
  currency?: string;
  description?: string;
  referenceId?: string;
  returnUrl: string;
  cancelUrl: string;
};

export type CreatedOrder = {
  mode: PaypalMode;
  orderId: string;
  status: string;
  approvalUrl: string;
};

export class PaypalError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "PaypalError";
  }
}

/** Integer cents -> "12.34". PayPal wants a decimal string. */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new PaypalError("amountCents must be a positive integer");
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

let cached: { key: string; client: Client } | null = null;

/** One long-lived client per credential pair (keeps the cached OAuth token). */
export function getClient(env: Env = process.env): Client {
  const id = env.PAYPAL_CLIENT_ID ?? "";
  const secret = env.PAYPAL_CLIENT_SECRET ?? "";
  const key = `${id}:${secret}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: new Client({
        environment: Environment.Sandbox,
        clientCredentialsAuthCredentials: { oAuthClientId: id, oAuthClientSecret: secret },
        timeout: 15000,
      }),
    };
  }
  return cached.client;
}

function simOrder(input: CreateOrderInput): CreatedOrder {
  const orderId = `SIM-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const url = new URL(input.returnUrl);
  url.searchParams.set("sim_order", orderId);
  return { mode: "sim", orderId, status: "CREATED", approvalUrl: url.toString() };
}

export async function createOrder(
  input: CreateOrderInput,
  opts: { env?: Env; client?: Client } = {},
): Promise<CreatedOrder> {
  const env = opts.env ?? process.env;
  const value = centsToValue(input.amountCents);
  if (paypalMode(env) === "sim" && !opts.client) return simOrder(input);

  const orders = new OrdersController(opts.client ?? getClient(env));
  try {
    const { result } = await orders.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: input.referenceId,
            description: input.description,
            amount: { currencyCode: input.currency ?? "USD", value },
          },
        ],
        applicationContext: {
          brandName: "Quoteloom",
          returnUrl: input.returnUrl,
          cancelUrl: input.cancelUrl,
        },
      },
      prefer: "return=representation",
    });
    const links = result.links ?? [];
    const approve = links.find((l) => l.rel === "approve" || l.rel === "payer-action");
    if (!result.id || !approve) throw new PaypalError("PayPal response had no approval link");
    return {
      mode: "sandbox",
      orderId: result.id,
      status: String(result.status ?? "CREATED"),
      approvalUrl: approve.href,
    };
  } catch (err) {
    if (err instanceof PaypalError) throw err;
    if (err instanceof ApiError) {
      throw new PaypalError(`PayPal rejected the request (HTTP ${err.statusCode})`, err.statusCode);
    }
    throw new PaypalError(`PayPal request failed: ${(err as Error).message}`);
  }
}
