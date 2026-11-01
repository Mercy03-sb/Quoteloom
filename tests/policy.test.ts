import { describe, expect, it } from "vitest";
import { checkQuantity, DEFAULT_RULES, parseRules, PolicyError } from "@/lib/policy";

describe("parseRules", () => {
  it("reads valid rules", () => {
    expect(parseRules('{"min_margin_pct":30,"max_discount_pct":5,"negotiation":false,"max_qty":3}')).toEqual({
      min_margin_pct: 30,
      max_discount_pct: 5,
      negotiation: false,
      max_qty: 3,
      quantity_breaks: [],
    });
  });
  it("falls back to defaults for missing, broken or out-of-range values", () => {
    expect(parseRules("{}")).toEqual(DEFAULT_RULES);
    expect(parseRules("not json")).toEqual(DEFAULT_RULES);
    expect(parseRules("[1,2]")).toEqual(DEFAULT_RULES);
    expect(parseRules('{"min_margin_pct":150,"max_qty":0,"negotiation":"yes"}')).toEqual(DEFAULT_RULES);
  });
});

describe("checkQuantity", () => {
  const rules = { ...DEFAULT_RULES, max_qty: 5 };
  it("accepts a quantity within limit and stock", () => {
    expect(() => checkQuantity(2, 10, rules)).not.toThrow();
    expect(() => checkQuantity(5, 5, rules)).not.toThrow();
  });
  it.each([0, -1, 1.5, Number.NaN])("rejects bad quantity %s", (q) => {
    expect(() => checkQuantity(q, 10, rules)).toThrowError(expect.objectContaining({ code: "bad_quantity" }));
  });
  it("enforces the per-order limit", () => {
    expect(() => checkQuantity(6, 100, rules)).toThrowError(expect.objectContaining({ code: "quantity_too_large" }));
  });
  it("rejects out of stock and insufficient stock", () => {
    expect(() => checkQuantity(1, 0, rules)).toThrowError(expect.objectContaining({ code: "out_of_stock" }));
    expect(() => checkQuantity(3, 2, rules)).toThrowError(expect.objectContaining({ code: "insufficient_stock" }));
    expect(() => checkQuantity(3, 2, rules)).toThrow(PolicyError);
  });
});
