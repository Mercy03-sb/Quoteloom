// PayPal Orders v2 (sandbox). Written with the APIMatic Context Plugin for PayPal
// (@paypal/paypal-server-sdk): orders, capture and webhook verification. With no credentials, everything runs in simulation.
import {
  ApiError,
  Client,
  CheckoutPaymentIntent,
  Environment,
  OrdersController,
} from "@paypal/paypal-server-sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
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

/** "12.34" -> 1234. Returns null for anything that is not a plain 2-decimal amount. */
export function valueToCents(value: string | undefined): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value ?? "");
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : null;
}

export type CapturedOrder = {
  mode: PaypalMode;
  status: string; // PayPal order status, "COMPLETED" on success
  captureId: string | null;
  amountCents: number | null;
  currency: string | null;
};

/**
 * Capture an approved order. In sim mode the buyer approval is implied and the expected
 * amount is echoed back. Sandbox errors (e.g. order not approved yet) become PaypalError.
 */
export async function captureOrder(
  orderId: string,
  expected: { amountCents: number; currency: string },
  opts: { env?: Env; client?: Client } = {},
): Promise<CapturedOrder> {
  const env = opts.env ?? process.env;
  if (paypalMode(env) === "sim" && !opts.client) {
    return {
      mode: "sim",
      status: "COMPLETED",
      captureId: `SIMCAP-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
      amountCents: expected.amountCents,
      currency: expected.currency,
    };
  }
  const orders = new OrdersController(opts.client ?? getClient(env));
  try {
    const { result } = await orders.captureOrder({
      id: orderId,
      paypalRequestId: `quoteloom-capture-${orderId}`, // idempotent retries
      prefer: "return=representation",
    });
    const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
    return {
      mode: "sandbox",
      status: String(result.status ?? "UNKNOWN"),
      captureId: capture?.id ?? null,
      amountCents: valueToCents(capture?.amount?.value),
      currency: capture?.amount?.currencyCode ?? null,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      throw new PaypalError(`PayPal could not capture the order (HTTP ${err.statusCode})`, err.statusCode);
    }
    throw new PaypalError(`PayPal request failed: ${(err as Error).message}`);
  }
}

// ---------- Webhooks ----------

export type WebhookHeaders = { get(name: string): string | null };

/** Sim-mode "PayPal" signs webhook bodies with this HMAC so the receiver exercises real verification code. */
export function simWebhookSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export const SIM_SIGNATURE_HEADER = "x-quoteloom-signature";

export async function verifyWebhook(args: {
  headers: WebhookHeaders;
  rawBody: string;
  simSecret: string;
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const env = args.env ?? process.env;
  if (paypalMode(env) === "sim") {
    const got = Buffer.from(args.headers.get(SIM_SIGNATURE_HEADER) ?? "");
    const want = Buffer.from(simWebhookSignature(args.rawBody, args.simSecret));
    return got.length === want.length && timingSafeEqual(got, want);
  }

  // Sandbox: the SDK has no webhook verification, so call PayPal's verify endpoint directly.
  const webhookId = env.PAYPAL_WEBHOOK_ID;
  const h = args.headers;
  const fields = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"].map(
    (n) => h.get(n),
  );
  if (!webhookId || fields.some((f) => !f)) return false;
  let event: unknown;
  try {
    event = JSON.parse(args.rawBody);
  } catch {
    return false;
  }
  const f = args.fetchImpl ?? fetch;
  const base = "https://api-m.sandbox.paypal.com";
  try {
    const tokenRes = await f(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenRes.ok) return false;
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    const res = await f(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        auth_algo: fields[0],
        cert_url: fields[1],
        transmission_id: fields[2],
        transmission_sig: fields[3],
        transmission_time: fields[4],
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { verification_status?: string }).verification_status === "SUCCESS";
  } catch {
    return false;
  }
}

// ---------- Disputes ----------
// @paypal/paypal-server-sdk 2.5.0 (checked with the APIMatic Context Plugin) has no Disputes controller,
// so evidence goes to the documented REST endpoint with plain fetch, like webhook verification above.

export type EvidenceSubmission = { mode: PaypalMode; ok: true; request: unknown; response: unknown };

/**
 * Submit evidence for a dispute. Simulated disputes, and sim mode, never touch the network but build the
 * same request body, so the packet-to-API step is exercised either way.
 */
export async function submitDisputeEvidence(
  disputeId: string,
  body: { evidences: { evidence_type: string; notes: string }[] },
  opts: { env?: Env; fetchImpl?: typeof fetch; simulated?: boolean } = {},
): Promise<EvidenceSubmission> {
  const env = opts.env ?? process.env;
  if (opts.simulated || paypalMode(env) === "sim") {
    return { mode: "sim", ok: true, request: { path: `/v1/customer/disputes/${disputeId}/provide-evidence`, body }, response: { simulated: true } };
  }
  const f = opts.fetchImpl ?? fetch;
  const base = "https://api-m.sandbox.paypal.com";
  try {
    const tokenRes = await f(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenRes.ok) throw new PaypalError(`PayPal sign-in failed (HTTP ${tokenRes.status})`, tokenRes.status);
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    const res = await f(`${base}/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let name = "";
      try {
        name = (JSON.parse(text) as { name?: string }).name ?? "";
      } catch {
        /* not JSON */
      }
      throw new PaypalError(`PayPal rejected the evidence (HTTP ${res.status}${name ? `, ${name}` : ""})`, res.status);
    }
    let response: unknown = {};
    try {
      response = text ? JSON.parse(text) : {};
    } catch {
      /* keep empty */
    }
    return { mode: "sandbox", ok: true, request: { path: `/v1/customer/disputes/${disputeId}/provide-evidence`, body }, response };
  } catch (err) {
    if (err instanceof PaypalError) throw err;
    throw new PaypalError(`PayPal request failed: ${(err as Error).message}`);
  }
}
