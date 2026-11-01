import { describe, expect, it } from "vitest";
import { weaveFor, weaveStyle } from "@/lib/design/weave";
import { DEMO_PRODUCTS } from "@/lib/seed-data";

describe("product weave", () => {
  it("gives every demo product a distinct pattern/colour pair", () => {
    const keys = DEMO_PRODUCTS.map((p) => {
      const w = weaveFor({ sku: p.sku, title: p.title, attrs: p.attrs });
      return `${w.pattern}:${w.hue}:${w.sat}`;
    });
    expect(new Set(keys).size).toBe(DEMO_PRODUCTS.length);
  });
  it("is stable for the same product", () => {
    const p = DEMO_PRODUCTS[0];
    const input = { sku: p.sku, title: p.title, attrs: p.attrs };
    expect(weaveFor(input)).toEqual(weaveFor(input));
  });
  it("uses the named colour attribute and produces CSS", () => {
    const w = weaveFor({ sku: "X", title: "Red thing", attrs: { color: "red", material: "linen" } });
    expect(w.hue).toBe(12);
    expect(weaveStyle(w).backgroundImage).toContain("gradient");
  });
});
