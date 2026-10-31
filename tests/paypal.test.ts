import { describe, expect, it } from "vitest";
import { Client, Environment } from "@paypal/paypal-server-sdk";
import { centsToValue, createOrder, PaypalError } from "@/lib/paypal";

const input = {
  amountCents: 1999,
  returnUrl: "http://localhost:3000/return",
  cancelUrl: "http://localhost:3000/cancel",
};

function stubClient(status: number, body: unknown) {
  const requests: { url: string; method: string; data?: string }[] = [];
  const client = new Client({
    environment: Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: "id",
      oAuthClientSecret: "secret",
      oAuthToken: {
        accessToken: "seeded",
        tokenType: "Bearer",
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      },
    },
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    unstable_httpClientOptions: {
      adapter: async (config: any) => {
        requests.push(config);
        return {
          data: JSON.stringify(body),
          status,
          statusText: "",
          headers: { "content-type": "application/json" },
          config,
        };
      },
    },
  });
  return { client, requests };
}

describe("centsToValue", () => {
  it("formats cents as a decimal string", () => {
    expect(centsToValue(1999)).toBe("19.99");
    expect(centsToValue(500)).toBe("5.00");
    expect(centsToValue(5)).toBe("0.05");
  });
  it("rejects non-positive or fractional amounts", () => {
    expect(() => centsToValue(0)).toThrow(PaypalError);
    expect(() => centsToValue(10.5)).toThrow(PaypalError);
  });
});

describe("createOrder in simulation mode (no credentials)", () => {
  it("returns a simulated order without any network call", async () => {
    const order = await createOrder(input, { env: {} });
    expect(order.mode).toBe("sim");
    expect(order.orderId).toMatch(/^SIM-/);
    expect(order.approvalUrl).toContain(`sim_order=${order.orderId}`);
  });
  it("stays simulated when PAYPAL_MODE=sim even with credentials", async () => {
    const order = await createOrder(input, {
      env: { PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_MODE: "sim" },
    });
    expect(order.mode).toBe("sim");
  });
});

describe("createOrder against a stubbed sandbox", () => {
  it("creates an order and returns the approval link", async () => {
    const { client, requests } = stubClient(201, {
      id: "5O190127TN364715T",
      status: "PAYER_ACTION_REQUIRED",
      links: [
        { href: "https://api.sandbox.paypal.com/v2/checkout/orders/5O1", rel: "self", method: "GET" },
        { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O1", rel: "payer-action", method: "GET" },
      ],
    });
    const order = await createOrder(input, { client });
    expect(order).toMatchObject({
      mode: "sandbox",
      orderId: "5O190127TN364715T",
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O1",
    });
    const req = requests.find((r) => r.url.includes("/v2/checkout/orders"))!;
    expect(req.method.toUpperCase()).toBe("POST");
    const body = JSON.parse(req.data!);
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "19.99" });
  });

  it("wraps PayPal API errors", async () => {
    const { client } = stubClient(422, { name: "UNPROCESSABLE_ENTITY" });
    await expect(createOrder(input, { client })).rejects.toMatchObject({
      name: "PaypalError",
      statusCode: 422,
    });
  });

  it("fails clearly when there is no approval link", async () => {
    const { client } = stubClient(201, { id: "X", status: "CREATED", links: [] });
    await expect(createOrder(input, { client })).rejects.toThrow(/approval link/);
  });
});
