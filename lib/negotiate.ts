// Counter-message drafting for the seller agent. The price is already decided by lib/policy.ts.
// Gemini (via lib/llm.ts) may phrase the reply; it can never change the price. Any draft that
// mentions an amount we did not give it is thrown away, and a template is used instead.
import type { DB } from "./db";
import { generateJson } from "./llm";
import type { PriceDecision } from "./policy";

type Env = Record<string, string | undefined>;

export type DraftedMessage = { text: string; source: "gemini" | "template" };

export type MessageFacts = {
  decision: PriceDecision;
  title: string;
  qty: number;
  currency: string;
  shopName: string;
};

/** Words that claim the end of the negotiation or a rock-bottom price. */
const FINALITY = /\b(final|finally|last|lowest|rock[- ]?bottom|non-?negotiable)\b/i;

const money = (c: number) => (c / 100).toFixed(2);

const SYSTEM =
  "You write the reply of a shop's seller agent to a buyer agent in a price negotiation. " +
  "The price has ALREADY been decided by the shop's rules. Write one or two short, polite sentences that state " +
  "the unit price exactly as given in the facts. Never mention any other price, discount, percentage, margin, cost, floor or round number, " +
  "and never promise anything else. If is_last_round is false, describe the price as the best you can do right now and " +
  'NEVER use the words "final", "last" or "lowest", and do not say the buyer cannot negotiate further. ' +
  'If is_last_round is true, say this is the final price. Reply as JSON: {"message": "..."}.';

/** Deterministic wording. Always available, used with no key or when the model fails or misbehaves. */
export function templateMessage(f: MessageFacts): string {
  const d = f.decision;
  const unit = `${money(d.unitPriceCents)} ${f.currency}`;
  const total = `${money(d.unitPriceCents * f.qty)} ${f.currency}`;
  switch (d.outcome) {
    case "accepted":
      return `Deal. We can do ${unit} per unit for ${f.qty} x ${f.title}, ${total} in total.`;
    case "countered":
      return `Thanks for the offer of ${money(d.offerCents ?? 0)} ${f.currency}. We cannot go that low, but the best I can do right now is ${unit} per unit (${total} for ${f.qty}).`;
    case "final_price":
      return `That is as low as we can go. ${unit} per unit is our final price (${total} for ${f.qty}).`;
    case "negotiation_off":
      return `${f.shopName} does not negotiate prices. The price is ${unit} per unit (${total} for ${f.qty}).`;
    case "offer_not_lower":
      return `Your offer is not below our current price, so the price is ${unit} per unit (${total} for ${f.qty}).`;
    case "quantity_break":
      return `A quantity discount applies: ${unit} per unit (${total} for ${f.qty}).`;
    default:
      return `${unit} per unit (${total} for ${f.qty}).`;
  }
}

/** Every number in the text must be one we handed the model, or the draft is rejected. */
export function messageIsSafe(text: string, f: MessageFacts): boolean {
  const d = f.decision;
  const allowed = new Set<string>([String(f.qty), money(d.unitPriceCents), money(d.unitPriceCents * f.qty)]);
  if (d.offerCents !== null) allowed.add(money(d.offerCents));
  if (!d.isFinal && FINALITY.test(text)) return false; // only the last round may be called final
  const nums = text.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return nums.every((n) => allowed.has(n.replace(/,/g, ""))); // exact text only: "1.00" is not the quantity 1
}

/** Draft the reply: Gemini if it works and passes the check, otherwise the template. Never throws. */
export async function draftMessage(
  db: DB,
  facts: MessageFacts,
  opts: { env?: Env; fetchImpl?: typeof fetch } = {},
): Promise<DraftedMessage> {
  const template: DraftedMessage = { text: templateMessage(facts), source: "template" };
  const d = facts.decision;
  const input = JSON.stringify({
    shop: facts.shopName,
    product: facts.title,
    quantity: facts.qty,
    currency: facts.currency,
    outcome: d.outcome,
    buyer_offer_per_unit: d.offerCents === null ? null : money(d.offerCents),
    unit_price: money(d.unitPriceCents),
    total: money(d.unitPriceCents * facts.qty),
    is_last_round: d.isFinal,
  });
  try {
    const r = await generateJson({ db, system: SYSTEM, input, env: opts.env, fetchImpl: opts.fetchImpl, timeoutMs: 4000 });
    if (!r.ok) return template;
    const parsed = JSON.parse(r.text) as { message?: unknown };
    const text = typeof parsed.message === "string" ? parsed.message.replace(/\s+/g, " ").trim() : "";
    if (!text || text.length > 400 || !messageIsSafe(text, facts)) return template;
    return { text, source: "gemini" };
  } catch {
    return template;
  }
}
