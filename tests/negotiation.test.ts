import { describe, expect, it } from "vitest";
import { getProduct } from "@/lib/catalog";
import { draftMessage, messageIsSafe, templateMessage } from "@/lib/negotiate";
import {
  askForRound,
  breakDiscountPct,
  DEFAULT_RULES,
  decideUnitPrice,
  finalPriceCents,
  floorPriceCents,
  MAX_ROUNDS,
  parseRules,
  validateRules,
  type PriceDecision,
  type ShopRules,
} from "@/lib/policy";
import { issueQuote, issueQuoteDrafted, loadVerifiedQuote, QUOTE_TTL_MS } from "@/lib/quote";
import { createShop, ShopError, updateShopRules } from "@/lib/shops";
import { resolveWorkspace } from "@/lib/workspace";
import { seededDb } from "./helpers";

const rules: ShopRules = { ...DEFAULT_RULES, negotiation: true, max_discount_pct: 15, min_margin_pct: 20, quantity_breaks: [] };
const LIST = 4800; // floor by discount = 4080, final price = 4116 (floor + 5% of the 720 room)
const decide = (over: Partial<Parameters<typeof decideUnitPrice>[0]> = {}) => decideUnitPrice({ listPriceCents: LIST, rules, ...over });

type Prior = NonNullable<Parameters<typeof decideUnitPrice>[0]["priorOffers"]>;
/** Run a sequence of offers from one agent, feeding each answer back as history (as lib/quote-issue does). */
function run(offers: number[], over: Partial<Parameters<typeof decideUnitPrice>[0]> = {}): PriceDecision[] {
  const prior: Prior = [];
  const out: PriceDecision[] = [];
  for (const offerCents of offers) {
    const d = decide({ ...over, offerCents, priorOffers: [...prior] });
    out.push(d);
    prior.push({ offerCents, unitPriceCents: d.unitPriceCents, askCents: d.askCents, tierPriceCents: d.breakPriceCents });
  }
  return out;
}

describe("the ask schedule", () => {
  it("starts below the standing price, concedes a fifth of the room each round and ends a little above the floor", () => {
    expect(floorPriceCents({ listPriceCents: LIST, rules }).floorCents).toBe(4080);
    expect(finalPriceCents(LIST, 4080)).toBe(4116);
    const asks = [1, 2, 3, 4, 5].map((n) => askForRound(LIST, 4080, n));
    expect(asks).toEqual([4664, 4527, 4390, 4253, 4116]);
    expect(asks[4]).toBe(finalPriceCents(LIST, 4080));
    expect(askForRound(LIST, 4080, 9)).toBe(4116); // later rounds stay at the final price
  });

  it("has no room to move when the floor equals the standing price", () => {
    expect(askForRound(4000, 4000, 1)).toBe(4000);
    expect(finalPriceCents(4000, 4000)).toBe(4000);
  });
});

describe("decideUnitPrice", () => {
  it("quotes list price with no offer", () => {
    expect(decide()).toMatchObject({ unitPriceCents: 4800, outcome: "list_price", negotiated: false, askCents: null });
  });

  it("counters a lower offer with the current ask, not a midpoint of the offer", () => {
    for (const offer of [1, 100, 3000, 4079, 4600]) {
      const d = decide({ offerCents: offer });
      expect(d).toMatchObject({ outcome: "countered", unitPriceCents: 4664, askCents: 4664, round: 1, isFinal: false });
    }
  });

  it("accepts an offer at or above the ask at the offered price", () => {
    expect(decide({ offerCents: 4664 })).toMatchObject({ outcome: "accepted", unitPriceCents: 4664 });
    expect(decide({ offerCents: 4700 })).toMatchObject({ outcome: "accepted", unitPriceCents: 4700 });
    expect(decide({ offerCents: 4799 })).toMatchObject({ outcome: "accepted", unitPriceCents: 4799 });
  });

  it("charges the standing price, never more, for an offer at or above it", () => {
    expect(decide({ offerCents: 4800 })).toMatchObject({ unitPriceCents: 4800, outcome: "offer_not_lower" });
    expect(decide({ offerCents: 99999 })).toMatchObject({ unitPriceCents: 4800, negotiated: false });
  });

  it("ignores offers when negotiation is off", () => {
    expect(decide({ offerCents: 4500, rules: { ...rules, negotiation: false } })).toMatchObject({ unitPriceCents: 4800, outcome: "negotiation_off", negotiated: false });
  });

  it("the user's lowball example: offering 90 then 95 on a 115.00 item never raises the ask", () => {
    const [a, b, c] = run([9000, 9500, 9000], { listPriceCents: 11500 });
    expect(a.askCents!).toBeGreaterThanOrEqual(b.askCents!);
    expect(b.askCents!).toBeGreaterThanOrEqual(c.askCents!);
    expect(b.unitPriceCents).toBeLessThanOrEqual(a.unitPriceCents);
    expect(a.unitPriceCents).toBe(a.askCents); // the counter is the ask, whatever the offer
    expect(a.askCents).toBe(askForRound(11500, 9775, 1));
  });

  it("only the last round is final: earlier rounds are 'best I can do right now'", () => {
    const ds = run([100, 100, 100, 100, 100, 100, 100]);
    expect(ds.map((d) => d.outcome)).toEqual(["countered", "countered", "countered", "countered", "final_price", "final_price", "final_price"]);
    expect(ds.map((d) => d.isFinal)).toEqual([false, false, false, false, true, true, true]);
    for (const d of ds.slice(0, 4)) {
      expect(`${d.note} ${d.publicReasons.join(" ")}`).not.toMatch(/\b(final|last|lowest)\b/i);
      expect(`${d.note} ${d.publicReasons.join(" ")}`).toContain("best");
    }
    expect(ds[4].note).toMatch(/final price/);
    expect(ds[4].publicReasons.join(" ")).toMatch(/final price/);
    expect(ds[4].unitPriceCents).toBe(4116);
    expect(ds[6].unitPriceCents).toBe(4116);
  });

  it("an offer at or above the ask in the last round is still accepted at the offered price", () => {
    const ds = run([100, 100, 100, 100, 4300]);
    expect(ds[4]).toMatchObject({ outcome: "accepted", unitPriceCents: 4300 });
  });

  it("keeps public reasons and the note free of the floor, cost and margin", () => {
    const ds = run([100, 3000, 4100, 4499, 100], { costCents: 3600 });
    for (const d of ds) {
      const text = `${d.note} ${d.publicReasons.join(" ")}`;
      expect(text).not.toMatch(/floor|cost|margin|round \d|schedule/i);
      expect(text).not.toContain((d.floorCents / 100).toFixed(2));
    }
    expect(ds[0].reasons.join(" ")).toMatch(/Floor is/); // the merchant log does keep it
    expect(ds[0].reasons.join(" ")).toMatch(/Round 1 of 5/);
  });

  it("enforces the minimum margin when the cost is known", () => {
    expect(floorPriceCents({ listPriceCents: LIST, costCents: 4000, rules }).floorCents).toBe(LIST); // margin needs more than list
    expect(decide({ offerCents: 4500, costCents: 4000 })).toMatchObject({ outcome: "countered", unitPriceCents: 4800 }); // no room: ask = list
    expect(floorPriceCents({ listPriceCents: LIST, costCents: 3600, rules })).toMatchObject({ floorCents: 4500, why: expect.stringContaining("margin") });
    for (const d of run([100, 100, 100, 100, 100], { costCents: 3600 })) expect(d.unitPriceCents).toBeGreaterThanOrEqual(4500);
  });

  it("honours a fixed product floor above the other limits", () => {
    expect(floorPriceCents({ listPriceCents: LIST, floorCents: 4700, rules }).floorCents).toBe(4700);
    for (const d of run([100, 100, 100, 100, 100], { floorCents: 4700 })) expect(d.unitPriceCents).toBeGreaterThanOrEqual(4700);
  });

  it("applies quantity breaks as the starting ask, bounded by the floor, and negotiates from there", () => {
    const r = { ...rules, quantity_breaks: [{ min_qty: 5, discount_pct: 5 }, { min_qty: 10, discount_pct: 10 }] };
    expect(breakDiscountPct(4, r)).toBe(0);
    expect(breakDiscountPct(5, r)).toBe(5);
    expect(breakDiscountPct(12, r)).toBe(10);
    expect(decide({ rules: r, qty: 4 }).unitPriceCents).toBe(4800);
    expect(decide({ rules: r, qty: 5 })).toMatchObject({ unitPriceCents: 4560, outcome: "quantity_break" });
    expect(decide({ rules: { ...r, quantity_breaks: [{ min_qty: 2, discount_pct: 60 }] }, qty: 2 }).unitPriceCents).toBe(4080); // clamped to the floor
    const d = decide({ rules: r, qty: 10, offerCents: 100 });
    expect(d.breakPriceCents).toBe(4320);
    expect(d.askCents).toBe(askForRound(4320, 4080, 1));
    expect(d.askCents!).toBeLessThan(4320);
    expect(decide({ rules: r, qty: 10, offerCents: 4400 })).toMatchObject({ unitPriceCents: 4320, outcome: "offer_not_lower" });
  });

  it("counts rounds per quantity tier: a different tier starts a fresh schedule, the same tier continues it", () => {
    const r = { ...rules, quantity_breaks: [{ min_qty: 5, discount_pct: 5 }] };
    const first = decide({ rules: r, qty: 1, offerCents: 100 });
    const prior: Prior = [{ offerCents: 100, unitPriceCents: first.unitPriceCents, askCents: first.askCents, tierPriceCents: first.breakPriceCents }];
    expect(decide({ rules: r, qty: 1, offerCents: 100, priorOffers: prior }).round).toBe(2);
    expect(decide({ rules: r, qty: 5, offerCents: 100, priorOffers: prior }).round).toBe(1);
  });

  it("never lets the ask rise even if the schedule would (rules edited mid-negotiation)", () => {
    const prior: Prior = [{ offerCents: 100, unitPriceCents: 3000, askCents: 3000, tierPriceCents: LIST }];
    expect(decide({ offerCents: 100, priorOffers: prior }).askCents).toBe(3000);
  });
});

// ---- property-style tests: seeded random sequences, many shops and offers ----
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("negotiation properties (random offer sequences)", () => {
  const CASES = 400;
  type Case = { list: number; qty: number; cost: number | null; rules: ShopRules; offers: number[] };
  function genCase(r: () => number): Case {
    const list = 500 + Math.floor(r() * 200000);
    const maxDisc = Math.floor(r() * 60);
    const breaks = r() < 0.5 ? [{ min_qty: 3, discount_pct: Math.min(maxDisc, 1 + Math.floor(r() * 10)) }].filter((b) => b.discount_pct > 0) : [];
    const kind = r();
    const offers = Array.from({ length: 1 + Math.floor(r() * 9) }, () => {
      const k = r();
      if (k < 0.15) return 1 + Math.floor(r() * 50); // absurd lowball
      if (k < 0.2) return list * 2; // above list
      return Math.max(1, Math.floor(list * (0.3 + r() * 0.8)));
    });
    return {
      list,
      qty: 1 + Math.floor(r() * 6),
      cost: kind < 0.5 ? null : Math.floor(list * (0.2 + r() * 0.7)),
      rules: { ...DEFAULT_RULES, negotiation: true, max_discount_pct: maxDisc, min_margin_pct: Math.floor(r() * 40), quantity_breaks: breaks },
      offers,
    };
  }
  const cases = (() => {
    const r = rng(20261101);
    return Array.from({ length: CASES }, () => genCase(r));
  })();
  const play = (c: Case, offers = c.offers) => run(offers, { listPriceCents: c.list, qty: c.qty, costCents: c.cost, rules: c.rules });

  it("the ask never increases from round to round, whatever is offered", () => {
    for (const c of cases) {
      const asks = play(c).map((d) => d.askCents!);
      for (let i = 1; i < asks.length; i++) expect(asks[i], JSON.stringify(c)).toBeLessThanOrEqual(asks[i - 1]);
    }
  });

  it("the ask depends only on the round: two different offer sequences give identical asks", () => {
    const r = rng(7);
    for (const c of cases) {
      const other = c.offers.map(() => 1 + Math.floor(r() * c.list * 2));
      expect(play(c).map((d) => d.askCents)).toEqual(play(c, other).map((d) => d.askCents));
    }
  });

  it("a counter is never below the floor and never above the standing price", () => {
    for (const c of cases) {
      for (const d of play(c)) {
        expect(d.unitPriceCents).toBeGreaterThanOrEqual(d.floorCents);
        expect(d.unitPriceCents).toBeLessThanOrEqual(d.breakPriceCents);
        if (d.outcome === "countered" || d.outcome === "final_price") expect(d.unitPriceCents).toBe(d.askCents);
      }
    }
  });

  it("an offer at or above the ask is always accepted at the offered price (capped at the standing price)", () => {
    for (const c of cases) {
      for (const d of play(c)) {
        if (d.offerCents! >= d.askCents!) {
          expect(["accepted", "offer_not_lower"]).toContain(d.outcome);
          expect(d.unitPriceCents).toBe(Math.min(d.offerCents!, d.breakPriceCents));
        } else {
          expect(["countered", "final_price"]).toContain(d.outcome);
        }
      }
    }
  });

  it("lowballing never yields a better price than offering exactly the ask in the same round", () => {
    for (const c of cases) {
      const prior: Prior = [];
      for (const offerCents of c.offers) {
        const lowball = decideUnitPrice({ listPriceCents: c.list, qty: c.qty, costCents: c.cost, rules: c.rules, offerCents, priorOffers: [...prior] });
        const atAsk = decideUnitPrice({ listPriceCents: c.list, qty: c.qty, costCents: c.cost, rules: c.rules, offerCents: lowball.askCents!, priorOffers: [...prior] });
        expect(lowball.unitPriceCents).toBeGreaterThanOrEqual(atAsk.unitPriceCents);
        expect(atAsk.unitPriceCents).toBe(Math.min(lowball.askCents!, atAsk.breakPriceCents));
        prior.push({ offerCents, unitPriceCents: lowball.unitPriceCents, askCents: lowball.askCents, tierPriceCents: lowball.breakPriceCents });
      }
    }
  });

  it("only round 5 and later may be worded as final, and the buyer text never contains the floor or cost words", () => {
    for (const c of cases) {
      play(c).forEach((d, i) => {
        const text = `${d.note} ${d.publicReasons.join(" ")}`;
        expect(text).not.toMatch(/floor|\bcost\b|margin/i);
        if (d.outcome === "countered") expect(text).not.toMatch(/\b(final|last|lowest)\b/i);
        if (d.outcome === "final_price") expect(i + 1).toBeGreaterThanOrEqual(MAX_ROUNDS);
        expect(d.isFinal).toBe(d.outcome === "final_price");
      });
    }
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

  it("signs the negotiated price and records request, ask, decision reasons and reply in the transcript", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku, qty: 1, offerCents: 4700, agentId: "agent-a" }, { now, secret: SECRET });
    expect(q.price_cents).toBe(4700);
    expect(q.outcome).toBe("accepted");
    expect(loadVerifiedQuote(db, shop, q.id, { now, secret: SECRET }).price_cents).toBe(4700);
    const row = db.prepare("SELECT transcript_json FROM quotes WHERE id = ?").get(q.id) as { transcript_json: string };
    const t = JSON.parse(row.transcript_json) as Record<string, unknown>[];
    expect(t.map((e) => e.type)).toEqual(["request", "decision", "message"]);
    expect(t[0]).toMatchObject({ offer_cents: 4700, agent: "agent-a" });
    expect(t[1]).toMatchObject({ outcome: "accepted", unit_price_cents: 4700, list_price_cents: 4800, ask_cents: 4664, round: 1, is_final: false });
    expect((t[1].reasons as string[]).join(" ")).toMatch(/Round 1 of 5/);
    expect(t[2]).toMatchObject({ source: "template" });
  });

  it("rejects a tampered negotiated price", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku, qty: 1, offerCents: 4700 }, { now, secret: SECRET });
    db.prepare("UPDATE quotes SET price_cents = 100 WHERE id = ?").run(q.id);
    expect(() => loadVerifiedQuote(db, shop, q.id, { now, secret: SECRET })).toThrowError(expect.objectContaining({ code: "bad_signature" }));
  });

  it("rejects an expired negotiated quote", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku, qty: 1, offerCents: 4700 }, { now, secret: SECRET });
    const later = new Date(now.getTime() + QUOTE_TTL_MS + 1000);
    expect(() => loadVerifiedQuote(db, shop, q.id, { now: later, secret: SECRET })).toThrowError(expect.objectContaining({ code: "expired" }));
  });

  it("walks the schedule across real quotes for one agent: asks fall every round, only round 5 is final", () => {
    const { db, shop } = seededDb();
    const quotes = [];
    for (let i = 0; i < 6; i++) {
      quotes.push(issueQuote(db, shop, { sku, qty: 1, offerCents: 90 + i, agentId: "hagg" }, { now: new Date(now.getTime() + i * 1000), secret: SECRET }));
    }
    expect(quotes.map((q) => q.price_cents)).toEqual([4664, 4527, 4390, 4253, 4116, 4116]);
    expect(quotes.map((q) => q.outcome)).toEqual(["countered", "countered", "countered", "countered", "final_price", "final_price"]);
    for (const q of quotes.slice(0, 4)) expect(`${q.message} ${q.public_reasons.join(" ")}`).not.toMatch(/\b(final|last|lowest)\b/i);
    expect(quotes[4].message).toMatch(/final price/);
    const t = JSON.parse((db.prepare("SELECT transcript_json FROM quotes WHERE id = ?").get(quotes[4].id) as { transcript_json: string }).transcript_json) as Record<string, unknown>[];
    expect(t.find((e) => e.type === "offer_history")).toMatchObject({ round: 5 });
    // a different agent, or a different quantity tier, starts a fresh schedule
    expect(issueQuote(db, shop, { sku, qty: 1, offerCents: 90, agentId: "other" }, { now, secret: SECRET }).price_cents).toBe(4664);
    expect(issueQuote(db, shop, { sku, qty: 5, offerCents: 90, agentId: "hagg" }, { now, secret: SECRET }).outcome).toBe("countered");
  });

  it("applies the demo shop's quantity break without an offer", () => {
    const { db, shop } = seededDb();
    expect(issueQuote(db, shop, { sku, qty: 5 }, { now, secret: SECRET }).price_cents).toBe(4560);
  });

  it("a shop with negotiation off quotes list price even for an offer", () => {
    const { db } = seededDb();
    const ws = resolveWorkspace(db, new Headers()).id;
    const { shop } = createShop(db, ws, { name: "Plain Shop", source_url: null, products: [{ sku: "P1", title: "Pot", description: "", price_cents: 1000, currency: "USD", stock: 5 }] });
    expect(issueQuote(db, shop, { sku: "P1", qty: 1, offerCents: 500 }, { now, secret: SECRET })).toMatchObject({ price_cents: 1000, outcome: "negotiation_off" });
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
    expect(q.message).toContain("46.64");
    expect(q.message).toContain("best I can do right now");
    expect(q.message).not.toMatch(/\b(final|last|lowest)\b/i);
  });

  it("uses a Gemini draft that only states decided amounts, and the price is still the code's", async () => {
    const { db, shop } = seededDb();
    const q = await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 100 }, { env: { GEMINI_API_KEY: KEY }, fetchImpl: reply("Thanks! The best I can do right now is 46.64 per unit.") as typeof fetch });
    expect(q.message_source).toBe("gemini");
    expect(q.price_cents).toBe(4664);
  });

  it("rejects a draft that promises another price", async () => {
    const { db, shop } = seededDb();
    const q = await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 4700 }, { env: { GEMINI_API_KEY: KEY }, fetchImpl: reply("Sure, take it for 1.00 each!") as typeof fetch });
    expect(q.message_source).toBe("template");
    expect(q.price_cents).toBe(4700);
    expect(q.message).not.toContain("1.00");
  });

  it("rejects a draft that calls an early-round price final, last or lowest, but allows it in the last round", async () => {
    const { db, shop } = seededDb();
    for (const bad of ["46.64 per unit is my final price.", "That is my lowest, 46.64 per unit.", "My last offer: 46.64 per unit."]) {
      const q = await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 100, agentId: `a-${bad.length}` }, { env: { GEMINI_API_KEY: KEY }, fetchImpl: reply(bad) as typeof fetch });
      expect(q.message_source, bad).toBe("template");
      expect(q.message).not.toMatch(/\b(final|last|lowest)\b/i);
    }
    const quotes = [];
    for (let i = 0; i < 5; i++) {
      quotes.push(await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 100 + i, agentId: "five" }, { env: { GEMINI_API_KEY: KEY }, fetchImpl: reply("That is the final price: 41.16 per unit.") as typeof fetch, now: new Date(Date.now() + i) }));
    }
    expect(quotes.slice(0, 4).every((q) => q.message_source === "template")).toBe(true);
    expect(quotes[4]).toMatchObject({ outcome: "final_price", message_source: "gemini" });
  });

  it("the Gemini prompt tells the model not to say final before the last round and never includes the floor", async () => {
    const { db, shop } = seededDb();
    let sent = "";
    await issueQuoteDrafted(db, shop, { sku, qty: 1, offerCents: 100 }, {
      env: { GEMINI_API_KEY: KEY },
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        sent = String(init?.body);
        return new Response("{}", { status: 500 });
      }) as unknown as typeof fetch,
    });
    const body = JSON.parse(sent) as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] };
    const system = body.systemInstruction.parts[0].text;
    const facts = body.contents[0].parts[0].text;
    expect(system).toMatch(/NEVER use the words "final"/);
    expect(facts).toContain('"is_last_round":false');
    expect(facts).not.toMatch(/floor|cost|margin|40\.80|41\.16/i);
  });

  it("falls back when Gemini errors", async () => {
    const { db } = seededDb();
    const m = await draftMessage(
      db,
      { decision: decideUnitPrice({ listPriceCents: 4800, offerCents: 4300, rules }), title: "Scarf", qty: 1, currency: "USD", shopName: "S" },
      { env: { GEMINI_API_KEY: KEY }, fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch },
    );
    expect(m.source).toBe("template");
  });

  it("messageIsSafe allows only the decided numbers", () => {
    const d = decideUnitPrice({ listPriceCents: 4800, offerCents: 4700, rules });
    const f = { decision: d, title: "Scarf", qty: 2, currency: "USD", shopName: "S" };
    expect(messageIsSafe("Deal at 47.00 each, 94.00 for 2.", f)).toBe(true);
    expect(messageIsSafe("Deal at 20% off", f)).toBe(false);
    expect(templateMessage(f)).toContain("47.00");
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
