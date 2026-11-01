// Deterministic merchant rules. Code decides prices and limits; an LLM may only draft text.
// Negotiation: the buyer may offer a unit price. This file decides the price from the shop's rules
// (quantity breaks, max discount, minimum margin, optional per-product floor). Nothing here calls an LLM.

export type QuantityBreak = { min_qty: number; discount_pct: number };

export type ShopRules = {
  min_margin_pct: number; // needs the product's cost (attrs.cost_cents); without a cost only max_discount_pct applies
  max_discount_pct: number; // deepest discount off list, from breaks and negotiation together
  negotiation: boolean; // off: buyers get list price (or the quantity break); offers are not entertained
  max_qty: number;
  quantity_breaks: QuantityBreak[]; // automatic discount from min_qty up, sorted by min_qty ascending
};

export const MAX_BREAKS = 4;

export const DEFAULT_RULES: ShopRules = {
  min_margin_pct: 20,
  max_discount_pct: 15,
  negotiation: true,
  max_qty: 20,
  quantity_breaks: [],
};

export type PolicyCode = "bad_quantity" | "quantity_too_large" | "out_of_stock" | "insufficient_stock";

export class PolicyError extends Error {
  constructor(
    readonly code: PolicyCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

function pct(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback;
}

/** Valid breaks only (whole min_qty >= 2, discount in (0, 100]), sorted, one per quantity, at most MAX_BREAKS. */
export function parseBreaks(v: unknown): QuantityBreak[] {
  if (!Array.isArray(v)) return [];
  const byQty = new Map<number, number>();
  for (const b of v) {
    const o = b as Record<string, unknown> | null;
    const q = o?.min_qty;
    const d = o?.discount_pct;
    if (typeof q === "number" && Number.isInteger(q) && q >= 2 && typeof d === "number" && Number.isFinite(d) && d > 0 && d <= 100) {
      byQty.set(q, d);
    }
  }
  return [...byQty]
    .map(([min_qty, discount_pct]) => ({ min_qty, discount_pct }))
    .sort((a, b) => a.min_qty - b.min_qty)
    .slice(0, MAX_BREAKS);
}

/** Tolerant parse of shops.rules_json: bad or missing values fall back to defaults. */
export function parseRules(json: string | null | undefined): ShopRules {
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(json || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
  } catch {
    /* keep defaults */
  }
  const maxQty = raw.max_qty;
  return {
    min_margin_pct: pct(raw.min_margin_pct, DEFAULT_RULES.min_margin_pct),
    max_discount_pct: pct(raw.max_discount_pct, DEFAULT_RULES.max_discount_pct),
    negotiation: typeof raw.negotiation === "boolean" ? raw.negotiation : DEFAULT_RULES.negotiation,
    max_qty: typeof maxQty === "number" && Number.isInteger(maxQty) && maxQty >= 1 ? maxQty : DEFAULT_RULES.max_qty,
    quantity_breaks: parseBreaks(raw.quantity_breaks),
  };
}

export type RulesCheck = { ok: true; rules: ShopRules } | { ok: false; error: string };

/** Strict validation for the rules editor: unlike parseRules, bad input is rejected, not defaulted. */
export function validateRules(v: unknown): RulesCheck {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "Rules must be an object." };
  const num = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
  if (typeof o.negotiation !== "boolean") return { ok: false, error: "Negotiation must be on or off." };
  if (!num(o.max_discount_pct, 0, 90)) return { ok: false, error: "Max discount must be between 0 and 90 percent." };
  if (!num(o.min_margin_pct, 0, 99)) return { ok: false, error: "Minimum margin must be between 0 and 99 percent." };
  if (typeof o.max_qty !== "number" || !Number.isInteger(o.max_qty) || o.max_qty < 1 || o.max_qty > 1000) {
    return { ok: false, error: "Max quantity must be a whole number from 1 to 1000." };
  }
  const raw = o.quantity_breaks ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_BREAKS) return { ok: false, error: `At most ${MAX_BREAKS} quantity breaks.` };
  const seen = new Set<number>();
  for (const b of raw as Record<string, unknown>[]) {
    if (!b || typeof b.min_qty !== "number" || !Number.isInteger(b.min_qty) || b.min_qty < 2 || b.min_qty > 1000) {
      return { ok: false, error: "A quantity break needs a whole quantity of at least 2." };
    }
    if (!num(b.discount_pct, 0.1, 90)) return { ok: false, error: "A quantity break discount must be between 0.1 and 90 percent." };
    if (seen.has(b.min_qty)) return { ok: false, error: "Two quantity breaks have the same quantity." };
    seen.add(b.min_qty);
  }
  const breaks = parseBreaks(raw);
  if (breaks.some((b) => b.discount_pct > (o.max_discount_pct as number))) {
    return { ok: false, error: "A quantity break cannot discount more than the max discount." };
  }
  return {
    ok: true,
    rules: {
      negotiation: o.negotiation,
      max_discount_pct: o.max_discount_pct as number,
      min_margin_pct: o.min_margin_pct as number,
      max_qty: o.max_qty,
      quantity_breaks: breaks,
    },
  };
}

/** Quantity must be a whole number, within the shop limit, and in stock. */
export function checkQuantity(qty: number, stock: number, rules: ShopRules): void {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new PolicyError("bad_quantity", "Quantity must be a whole number of at least 1.");
  }
  if (qty > rules.max_qty) {
    throw new PolicyError("quantity_too_large", `This shop sells at most ${rules.max_qty} per order.`);
  }
  if (stock <= 0) throw new PolicyError("out_of_stock", "This product is out of stock.");
  if (qty > stock) throw new PolicyError("insufficient_stock", `Only ${stock} in stock.`);
}

export type Outcome =
  | "list_price" // no offer, no break: list price
  | "quantity_break" // no usable offer; the break price applies
  | "accepted" // the offer was at or above the floor and below the standing price
  | "countered" // the offer was below the floor; we name the best price we can do
  | "negotiation_off"
  | "offer_not_lower" // the offer was at or above the standing price
  | "round_limit"; // too many rounds: no further concessions

export const MAX_ROUNDS = 5;

export type PriceDecision = {
  unitPriceCents: number;
  negotiated: boolean; // true when the final price came from the buyer's offer or a counter, not just list/break
  outcome: Outcome;
  note: string; // template wording of the decision (an LLM may rephrase it, the price stays)
  reasons: string[]; // each deterministic step, for the merchant (mentions the floor)
  publicReasons: string[]; // the same decision in words that are safe to show the buyer (no floor, cost or margin)
  listPriceCents: number;
  breakPriceCents: number;
  floorCents: number;
  offerCents: number | null;
  round: number;
};

const dollars = (c: number) => (c / 100).toFixed(2);

/** The lowest unit price the shop will go to: the highest of max-discount price, margin price on cost, and a fixed floor. */
export function floorPriceCents(input: {
  listPriceCents: number;
  costCents?: number | null;
  floorCents?: number | null;
  rules: ShopRules;
}): { floorCents: number; why: string } {
  const { listPriceCents, rules } = input;
  let floor = Math.ceil((listPriceCents * (100 - rules.max_discount_pct)) / 100);
  let why = `max discount ${rules.max_discount_pct}%`;
  if (input.costCents && input.costCents > 0) {
    // margin on price: (p - c) / p >= m  =>  p >= c / (1 - m)
    const byMargin = Math.ceil((input.costCents * 100) / (100 - Math.min(rules.min_margin_pct, 99)));
    if (byMargin > floor) {
      floor = byMargin;
      why = `minimum margin ${rules.min_margin_pct}%`;
    }
  }
  if (input.floorCents && input.floorCents > floor) {
    floor = input.floorCents;
    why = "the product floor price";
  }
  return { floorCents: Math.min(floor, listPriceCents), why };
}

/** The automatic quantity-break discount for this quantity (0 when no break applies). */
export function breakDiscountPct(qty: number, rules: ShopRules): number {
  let p = 0;
  for (const b of rules.quantity_breaks) if (qty >= b.min_qty) p = b.discount_pct;
  return p;
}

/**
 * Decide the unit price. Deterministic. Order of reasoning:
 * 1. start from list; a quantity break lowers the standing price (never below the floor);
 * 2. no offer, or negotiation off: the standing price;
 * 3. an offer at or above the standing price changes nothing; an offer at or above the floor is accepted;
 *    an offer below the floor gets a counter at the midpoint to the standing price, never below the floor;
 * 4. once the same agent has had MAX_ROUNDS answers for this SKU, the best price already given is final.
 */
export function decideUnitPrice(input: {
  listPriceCents: number;
  qty?: number;
  offerCents?: number;
  costCents?: number | null;
  floorCents?: number | null;
  rules: ShopRules;
  /** Answers this agent already got for this SKU (offer history), oldest first. */
  priorOffers?: { offerCents: number | null; unitPriceCents: number }[];
}): PriceDecision {
  const { listPriceCents, rules } = input;
  const qty = input.qty ?? 1;
  const offer = input.offerCents ?? null;
  const prior = input.priorOffers ?? [];
  const round = prior.length + 1;
  const reasons: string[] = [];
  const pub: string[] = [];
  const { floorCents, why } = floorPriceCents({ listPriceCents, costCents: input.costCents, floorCents: input.floorCents, rules });

  const brk = breakDiscountPct(qty, rules);
  let standing = listPriceCents;
  if (brk > 0) {
    standing = Math.max(floorCents, Math.round((listPriceCents * (100 - brk)) / 100));
    reasons.push(`Quantity break: ${brk}% off for ${qty} or more, giving ${dollars(standing)}.`);
    pub.push(`Quantity discount: ${brk}% off for ${qty} or more, giving ${dollars(standing)} per unit.`);
  }
  reasons.push(`Floor is ${dollars(floorCents)} (${why}).`);
  const base = { listPriceCents, breakPriceCents: standing, floorCents, offerCents: offer, round };
  const done = (unit: number, outcome: Outcome, negotiated: boolean, note: string): PriceDecision => ({
    ...base,
    unitPriceCents: unit,
    outcome,
    negotiated,
    note,
    reasons,
    publicReasons: pub,
  });

  if (offer === null) {
    return brk > 0
      ? done(standing, "quantity_break", false, `Quantity break applied: ${dollars(standing)} per unit.`)
      : done(standing, "list_price", false, "Quoted at list price.");
  }
  if (!rules.negotiation) {
    reasons.push("Negotiation is off for this shop, so the offer was not considered.");
    pub.push("This shop does not negotiate, so your offer was not considered.");
    return done(standing, "negotiation_off", false, `This shop does not negotiate. The price is ${dollars(standing)} per unit.`);
  }
  if (offer >= standing) {
    reasons.push(`Offer ${dollars(offer)} is not below the standing price ${dollars(standing)}; no discount needed.`);
    pub.push(`Your offer of ${dollars(offer)} is not below the current price of ${dollars(standing)}, so no discount applies.`);
    return done(standing, "offer_not_lower", false, `Your offer is not below the current price, so the price stays ${dollars(standing)} per unit.`);
  }
  if (prior.length >= MAX_ROUNDS) {
    const best = Math.min(standing, ...prior.map((p) => p.unitPriceCents));
    reasons.push(`Round limit of ${MAX_ROUNDS} reached; the best price already given (${dollars(best)}) is final.`);
    pub.push(`The negotiation limit was reached, so ${dollars(best)} per unit is final.`);
    return done(best, "round_limit", true, `We have reached the end of negotiation. Our final price is ${dollars(best)} per unit.`);
  }
  if (offer >= floorCents) {
    reasons.push(`Offer ${dollars(offer)} is at or above the floor ${dollars(floorCents)}: accepted.`);
    pub.push(`Your offer of ${dollars(offer)} is within what the shop can accept.`);
    return done(offer, "accepted", true, `Offer accepted at ${dollars(offer)} per unit.`);
  }
  const mid = Math.ceil((offer + standing) / 2);
  const counter = Math.min(standing, Math.max(floorCents, mid));
  reasons.push(
    `Offer ${dollars(offer)} is below the floor ${dollars(floorCents)}. Counter: midpoint ${dollars(mid)}, held at or above the floor, gives ${dollars(counter)}.`,
  );
  pub.push(`Your offer of ${dollars(offer)} is lower than the shop can accept. The best price it can do is ${dollars(counter)} per unit.`);
  return done(counter, "countered", true, `We cannot go as low as ${dollars(offer)}. The best we can do is ${dollars(counter)} per unit.`);
}
