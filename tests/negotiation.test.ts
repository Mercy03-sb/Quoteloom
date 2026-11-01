import { describe, expect, it } from "vitest";
import { getProduct } from "@/lib/catalog";
import { draftMessage, messageIsSafe, templateMessage } from "@/lib/negotiate";
import {
  breakDiscountPct,
  DEFAULT_RULES,
  decideUnitPrice,
  floorPriceCents,
  MAX_ROUNDS,
  parseRules,
  validateRules,
  type ShopRules,
} from "@/lib/policy";
import { issueQuote, issueQuoteDrafted, loadVerifiedQuote, QUOTE_TTL_MS } from "@/lib/quote";
import { ShopError, updateShopRules } from "@/lib/shops";
import { resolveWorkspace } from "@/lib/workspace";
import { createShop } from "@/lib/shops";
import { seededDb } from "./helpers";

const rules: ShopRules = { ...DEFAULT_RULES, negotiation: true, max_discount_pct: 15, min_margin_pct: 20, quantity_breaks: [] };
const LIST = 4800; // floor by discount = 4080
const decide = (over: Partial<Parameters<typeof decideUnitPrice>[0]> = {}) => decideUnitPrice({ listPriceCents: LIST, rules, ...over });

describe("decideUnitPrice", () => {
  it("quotes list price with no offer", () => {
    expect(decide()).toMatchObject({ unitPriceCents: 4800, outcome: "list_price", negotiated: false });
  });

  it("accepts an offer at or above the floor, below list", () => {
    expect(decide({ offerCents: 4500 })).toMatchObject({ unitPriceCents: 4500, outcome: "accepted", negotiated: true });
    expect(decide({ offerCents: 4080 })).toMatchObject({ unitPriceCents: 4080, outcome: "accepted" }); // exactly the floor
  });

  it("counters an offer below the floor, never going under it", () => {
    const d = decide({ offerCents: 4079 });
    expect(d.outcome).toBe("countered");
    expect(d.unitPriceCents).toBeGreaterThanOrEqual(4080);
    expect(d.unitPriceCents).toBeLessThan(LIST);
    const lowball = decide({ offerCents: 1 });
    expect(lowball.unitPriceCents).toBe(4080); // midpoint (2401) is under the floor, so the floor holds
    expect(lowball.reasons.join(" ")).toMatch(/below the floor/);
  });

  it("does not raise the price for an offer at or above the standing price", () => {
    expect(decide({ offerCents: 4800 })).toMatchObject({ unitPriceCents: 4800, outcome: "offer_not_lower" });
    expect(decide({ offerCents: 99999 })).toMatchObject({ unitPriceCents: 4800, negotiated: false });
  });

  it("ignores offers when negotiation is off", () => {
    const d = decide({ offerCents: 4500, rules: { ...rules, negotiation: false } });
    expect(d).toMatchObject({ unitPriceCents: 4800, outcome: "negotiation_off", negotiated: false });
  });

  it("enforces the minimum margin when the cost is known", () => {
    // cost 4000 at 20% margin on price needs 5000, above list: the floor is capped at list price.
    expect(floorPriceCents({ listPriceCents: LIST, costCents: 4000, rules }).floorCents).toBe(LIST);
    expect(decide({ offerCents: 4500, costCents: 4000 })).toMatchObject({ unitPriceCents: 4800, outcome: "countered" });
    // cost 3600 -> 4500 minimum, higher than the discount floor of 4080
    const f = floorPriceCents({ listPriceCents: LIST, costCents: 3600, rules });
    expect(f).toMatchObject({ floorCents: 4500, why: expect.stringContaining("margin") });
    expect(decide({ offerCents: 4400, costCents: 3600 }).unitPriceCents).toBeGreaterThanOrEqual(4500);
    expect(decide({ offerCents: 4500, costCents: 3600 })).toMatchObject({ unitPriceCents: 4500, outcome: "accepted" });
  });

  it("honours a fixed product floor above the other limits", () => {
    expect(floorPriceCents({ listPriceCents: LIST, floorCents: 4700, rules }).floorCents).toBe(4700);
    expect(decide({ offerCents: 4300, floorCents: 4700 }).unitPriceCents).toBeGreaterThanOrEqual(4700);
  });

  it("applies quantity breaks, bounded by the floor, even without an offer", () => {
    const r = { ...rules, quantity_breaks: [{ min_qty: 5, discount_pct: 5 }, { min_qty: 10, discount_pct: 10 }] };
    expect(breakDiscountPct(4, r)).toBe(0);
    expect(breakDiscountPct(5, r)).toBe(5);
    expect(breakDiscountPct(12, r)).toBe(10);
    expect(decide({ rules: r, qty: 4 }).unitPriceCents).toBe(4800);
    expect(decide({ rules: r, qty: 5 })).toMatchObject({ unitPriceCents: 4560, outcome: "quantity_break" });
    // a break deeper than the cap is clamped to the floor
    expect(decide({ rules: { ...r, quantity_breaks: [{ min_qty: 2, discount_pct: 60 }] }, qty: 2 }).unitPriceCents).toBe(4080);
    // an offer is measured against the break price, not list
    expect(decide({ rules: r, qty: 10, offerCents: 4200 })).toMatchObject({ unitPriceCents: 4200, outcome: "accepted", breakPriceCents: 4320 });
    expect(decide({ rules: r, qty: 10, offerCents: 4400 })).toMatchObject({ unitPriceCents: 4320, outcome: "offer_not_lower" });
  });

  it("stops conceding after the round limit and keeps the best price already given", () => {
    const prior = Array.from({ length: MAX_ROUNDS }, (_, i) => ({ offerCents: 3000, unitPriceCents: 4300 - i * 10 }));
    const d = decide({ offerCents: 3500, priorOffers: prior });
    expect(d.outcome).toBe("round_limit");
    expect(d.unitPriceCents).toBe(4300 - (MAX_ROUNDS - 1) * 10);
    expect(decide({ offerCents: 3500, priorOffers: prior.slice(0, MAX_ROUNDS - 1) }).outcome).not.toBe("round_limit");
  });
});

describe("rules parsing and validation", () => {
  it("parses breaks tolerantly: drops bad entries, sorts, caps the count", () => {
    const r = parseRules(JSON.stringify({ quantity_breaks: [{ min_qty: 10, discount_pct: 10 }, { min_qty: 1, discount_pct: 5 }, { min_qty: 5, discount_pct: 0 }, { min_qty: 3, discount_pct: 4 }, "x"] }));
    expect(r.quantity_breaks).toEqual([{ min_qty: 3, discount_pct: 4 }, { min_qty: 10, discount_pct: 10 }]);
  });
  const good = { negotiation: true, max_discount_pct: 20, min_margin_pct: 10, max_qty: 5, quantity_breaks: [{ min_qty: 3, discount_pct: 5 }] };
  it("accepts good rules", () => {
    expect(validateRules(good)).toMatchObject({ ok: true });
  });
  it.each([
    ["not an object", null],
    ["negotiation not boolean", { ...good, negotiation: "yes" }],
    ["discount over 90", { ...good, max_discount_pct: 95 }],
    ["negative margin", { ...good, min_margin_pct: -1 }],
    ["margin 100", { ...good, min_margin_pct: 100 }],
    ["fractional max qty", { ...good, max_qty: 2.5 }],
    ["too many breaks", { ...good, quantity_breaks: [2, 3, 4, 5, 6].map((q) => ({ min_qty: q, discount_pct: 1 })) }],
    ["duplicate break", { ...good, quantity_breaks: [{ min_qty: 3, discount_pct: 1 }, { min_qty: 3, discount_pct: 2 }] }],
    ["break deeper than the cap", { ...good, quantity_breaks: [{ min_qty: 3, discount_pct: 25 }] }],
    ["break qty 1", { ...good, quantity_breaks: [{ min_qty: 1, discount_pct: 5 }] }],
  ])("rejects %s", (_n, v) => {
    expect(validateRules(v)).toMatchObject({ ok: false });
  });
});

describe("negotiated quotes", () => {
  const SECRET = "neg-secret";
  const now = new Date("2026-11-01T10:00:00Z");
  const sku = "LT-SCARF-WOOL-GRY";

  it("signs the negotiated price and records request, decision reasons and reply in the transcript", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku, qty: 1, offerCents: 4300, agentId: "agent-a" }, { now, secret: SECRET });
    expect(q.price_cents).toBe(4300);
    expect(q.outcome).toBe("accepted");
    expect(loadVerifiedQuote(db, shop, q.id, { now, secret: SECRET }).price_cents).toBe(4300);
    const row = db.prepare("SELECT transcript_json FROM quotes WHERE id = ?").get(q.id) as { transcript_json: string };
    const t = JSON.parse(row.transcript_json) as Record<string, unknown>[];
    expect(t.map((e) => e.type)).toEqual(["request", "decision", "message"]);
    expect(t[0]).toMatchObject({ offer_cents: 4300, agent: "agent-a" });
    expect(t[1]).toMatchObject({ outcome: "accepted", unit_price_cents: 4300, list_price_cents: 4800 });
    expect((t[1].reasons as string[]).length).toBeGreaterThan(0);
    expect(t[2]).toMatchObject({ source: "template" });
  });

  it("rejects a tampered negotiated price", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku, qty: 1, offerCents: 4300 }, { now, secret: SECRET });
    db.prepare("UPDATE quotes SET price_cents = 100 WHERE id = ?").run(q.id);
    expect(() => loadVerifiedQuote(db, shop, q.id, { now, secret: SECRET })).toThrowError(expect.objectContaining({ code: "bad_signature" }));
  });

  it("rejects an expired negotiated quote", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku, qty: 1, offerCents: 4300 }, { now, secret: SECRET });
    const later = new Date(now.getTime() + QUOTE_TTL_MS + 1000);
    expect(() => loadVerifiedQuote(db, shop, q.id, { now: later, secret: SECRET })).toThrowError(expect.objectContaining({ code: "expired" }));
  });

  it("builds an offer history for the same agent and SKU, and ends negotiation at the round limit", () => {
    const { db, shop } = seededDb();
    const quotes = [];
    for (let i = 0; i < MAX_ROUNDS + 1; i++) {
      quotes.push(issueQuote(db, shop, { sku, qty: 1, offerCents: 500 + i, agentId: "hagg" }, { now: new Date(now.getTime() + i * 1000), secret: SECRET }));
    }
    const last = quotes[MAX_ROUNDS];
    expect(last.outcome).toBe("round_limit");
    expect(last.price_cents).toBe(4080);
    const t = JSON.parse((db.prepare("SELECT transcript_json FROM quotes WHERE id = ?").get(last.id) as { transcript_json: string }).transcript_json) as Record<string, unknown>[];
    expect(t.find((e) => e.type === "offer_history")).toMatchObject({ round: MAX_ROUNDS + 1 });
    // a different agent starts fresh
    expect(issueQuote(db, shop, { sku, qty: 1, offerCents: 500, agentId: "other" }, { now, secret: SECRET }).outcome).toBe("countered");
  });

  it("applies the demo shop's quantity break without an offer", () => {
    const { db, shop } = seededDb();
    expect(issueQuote(db, shop, { sku, qty: 5 }, { now, secret: SECRET }).price_cents).toBe(4560);
  });

  it("a shop with negotiation off quotes list price even for an offer", () => {
    const { db } = seededDb();
    const ws = resolveWorkspace(db, new Headers()).id;
    const { shop } = createShop(db, ws, { name: "Plain Shop", source_url: null, products: [{ sku: "P1", title: "Pot", description: "", price_cents: 1000, currency: "USD", stock: 5 }] });
    const q = issueQuote(db, shop, { sku: "P1", qty: 1, offerCents: 500 }, { now, secret: SECRET });
    expect(q).toMatchObject({ price_cents: 1000, outcome: "negotiation_off" });
  });
});

describe("counter message drafting", () => {
  const sku = "LT-SCARF-WOOL-GRY";
  const KEY = ["fake", "gemini", "test", "key", "1234567890"].join("-");
  const reply = (message: string) => async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ message }) }] } }] }), { status: 200 });

  it("uses the template without a key and makes no network call", async () => {
    const { db, shop } = seededDb();
    let calls = 0;
    const q = await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 100 }, { env: {}, fetchImpl: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
    expect(calls).toBe(0);
    expect(q.message_source).toBe("template");
    expect(q.message).toContain("40.80");
  });

  it("uses a Gemini draft that only states decided amounts, and the price is still the code's", async () => {
    const { db, shop } = seededDb();
    const q = await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 100 }, { env: { GEMINI_API_KEY: KEY }, fetchImpl: reply("Thanks! We can do 40.80 per unit.") as typeof fetch });
    expect(q.message_source).toBe("gemini");
    expect(q.price_cents).toBe(4080);
  });

  it("rejects a Gemini draft that promises another price and falls back to the template", async () => {
    const { db, shop } = seededDb();
    const q = await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 4300 }, { env: { GEMINI_API_KEY: KEY }, fetchImpl: reply("Sure, take it for 1.00 each!") as typeof fetch });
    expect(q.message_source).toBe("template");
    expect(q.price_cents).toBe(4300);
    expect(q.message).not.toContain("1.00");
  });

  it("falls back when Gemini errors", async () => {
    const { db, shop } = seededDb();
    const m = await draftMessage(
      db,
      { decision: decideUnitPrice({ listPriceCents: 4800, offerCents: 4300, rules }), title: "Scarf", qty: 1, currency: "USD", shopName: "S" },
      { env: { GEMINI_API_KEY: KEY }, fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch },
    );
    expect(m.source).toBe("template");
  });

  it("messageIsSafe allows only the decided numbers", () => {
    const d = decideUnitPrice({ listPriceCents: 4800, offerCents: 4300, rules });
    const f = { decision: d, title: "Scarf", qty: 2, currency: "USD", shopName: "S" };
    expect(messageIsSafe("Deal at 43.00 each, 86.00 for 2.", f)).toBe(true);
    expect(messageIsSafe("Deal at 20% off", f)).toBe(false);
    expect(templateMessage(f)).toContain("43.00");
  });
});

describe("get_product and settings", () => {
  it("returns public details without cost or floor, plus the quantity discounts", () => {
    const { db, shop } = seededDb();
    const p = getProduct(db, shop, "LT-SCARF-WOOL-GRY")!;
    expect(p).toMatchObject({ sku: "LT-SCARF-WOOL-GRY", price: "48.00", stock: 14, negotiable: true });
    expect(p.attributes).toMatchObject({ material: "merino wool", color: "grey" });
    expect(JSON.stringify(p)).not.toMatch(/cost|floor|margin/i);
    expect(p.quantity_discounts).toEqual([{ min_qty: 5, discount_pct: 5 }, { min_qty: 10, discount_pct: 10 }]);
    expect(getProduct(db, shop, "NOPE")).toBeUndefined();
  });

  it("lets a workspace edit its own shop's rules, never the demo shop or someone else's", () => {
    const { db } = seededDb();
    const a = resolveWorkspace(db, new Headers()).id;
    const b = resolveWorkspace(db, new Headers()).id;
    const { shop } = createShop(db, a, { name: "Mine", source_url: null, products: [{ sku: "P1", title: "Pot", description: "", price_cents: 1000, currency: "USD", stock: 5 }] });
    const next = { negotiation: true, max_discount_pct: 30, min_margin_pct: 10, max_qty: 7, quantity_breaks: [{ min_qty: 3, discount_pct: 10 }] };
    updateShopRules(db, a, shop.slug, next);
    expect(parseRules((db.prepare("SELECT rules_json FROM shops WHERE slug = ?").get(shop.slug) as { rules_json: string }).rules_json)).toEqual(next);
    expect(() => updateShopRules(db, b, shop.slug, next)).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(() => updateShopRules(db, a, "loom-and-thread", next)).toThrowError(expect.objectContaining({ code: "read_only" }));
    expect(() => updateShopRules(db, a, shop.slug, { ...next, max_discount_pct: 999 })).toThrow(ShopError);
  });
});
