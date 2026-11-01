// Deterministic merchant rules. Code decides prices and limits; an LLM may only draft text.
// Milestone 2b: everything is quoted at list price. Negotiation (using min_margin_pct,
// max_discount_pct and `negotiation`) arrives in Milestone 4, but the rules are parsed now.

export type ShopRules = {
  min_margin_pct: number;
  max_discount_pct: number;
  negotiation: boolean;
  max_qty: number;
};

export const DEFAULT_RULES: ShopRules = {
  min_margin_pct: 20,
  max_discount_pct: 15,
  negotiation: true,
  max_qty: 20,
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

export type PriceDecision = {
  unitPriceCents: number;
  negotiated: boolean;
  note: string;
};

/** Milestone 2b: always list price. An offer is acknowledged but never lowers the price. */
export function decideUnitPrice(input: {
  listPriceCents: number;
  offerCents?: number;
  rules: ShopRules;
}): PriceDecision {
  const { listPriceCents, offerCents } = input;
  if (offerCents !== undefined && offerCents < listPriceCents) {
    return {
      unitPriceCents: listPriceCents,
      negotiated: false,
      note: "Negotiation is not available yet, so this is quoted at list price.",
    };
  }
  return { unitPriceCents: listPriceCents, negotiated: false, note: "Quoted at list price." };
}
