import { describe, expect, it } from "vitest";
import { databasePath, llmMode, paypalMode } from "@/lib/config";

describe("simulation mode with no env vars", () => {
  it("defaults everything to simulation", () => {
    expect(paypalMode({})).toBe("sim");
    expect(llmMode({})).toBe("fallback");
    expect(databasePath({})).toBe("data/quoteloom.db");
  });

  it("stays in sim when PayPal credentials are incomplete", () => {
    expect(paypalMode({ PAYPAL_CLIENT_ID: "x", PAYPAL_MODE: "sandbox" })).toBe("sim");
  });

  it("uses sandbox when credentials exist, unless forced to sim", () => {
    const creds = { PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y" };
    expect(paypalMode(creds)).toBe("sandbox");
    expect(paypalMode({ ...creds, PAYPAL_MODE: "sim" })).toBe("sim");
  });

  it("uses Gemini only when a key is set", () => {
    expect(llmMode({ GEMINI_API_KEY: "k" })).toBe("gemini");
  });
});
