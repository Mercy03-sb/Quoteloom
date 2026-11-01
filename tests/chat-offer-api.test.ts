import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as chat } from "@/app/api/chat/route";
import { installTestDb, jsonReq } from "./helpers";

beforeEach(() => {
  installTestDb();
  vi.stubEnv("GEMINI_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

const call = (body: unknown) => chat(jsonReq("http://localhost:3000/api/chat", body));

describe("chat quote action with an offer", () => {
  it("passes offer_price to request_quote and returns buyer-safe reasons, list price and quantity discounts", async () => {
    const out = (await (await call({ action: "quote", shop: "loom-and-thread", sku: "LT-SCARF-WOOL-GRY", qty: 1, offer_price: 10 })).json()) as {
      isError: boolean;
      result: { unit_price: string; list_price: string; quantity_discounts: unknown[]; negotiation: { outcome: string; reasons: string[]; offered: string } };
    };
    expect(out.isError).toBe(false);
    const r = out.result;
    expect(r.negotiation).toMatchObject({ outcome: "countered", offered: "10.00" });
    expect(r.unit_price).toBe("40.80");
    expect(r.list_price).toBe("48.00");
    expect(r.quantity_discounts).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/floor|margin|cost/i); // merchant limits stay private
    expect(r.negotiation.reasons.join(" ")).toContain("best price it can do is 40.80");
  });

  it("rejects a bad offer and still works with no offer", async () => {
    expect((await call({ action: "quote", shop: "loom-and-thread", sku: "X", qty: 1, offer_price: -1 })).status).toBe(400);
    expect((await call({ action: "quote", shop: "loom-and-thread", sku: "X", qty: 1, offer_price: "abc" })).status).toBe(400);
    const ok = (await (await call({ action: "quote", shop: "loom-and-thread", sku: "LT-SCARF-WOOL-GRY", qty: 5 })).json()) as {
      result: { unit_price: string; negotiation: { offered: null } };
    };
    expect(ok.result.unit_price).toBe("45.60");
    expect(ok.result.negotiation.offered).toBeNull();
  });
});
