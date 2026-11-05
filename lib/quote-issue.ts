// Issuing quotes: policy decides the price, the quote is signed and stored with a transcript of the
// request, the offer history, the decision reasons and the reply text. See lib/policy.ts for the rules.
import { randomBytes } from "node:crypto";
import type { Shop } from "./catalog";
import type { DB } from "./db";
import { draftMessage, templateMessage } from "./negotiate";
import { checkQuantity, decideUnitPrice, parseRules, type Outcome, type PriceDecision, type QuantityBreak } from "./policy";
import { marketReference, type MarketReference } from "./market";
import type { LookupCtx } from "./channel3";
import { QUOTE_TTL_MS, QuoteError, signQuote, signingSecret, type Quote, type QuoteFields } from "./quote";

type ProductForQuote = { title: string; price_cents: number; currency: string; stock: number; attrs_json: string };

export type IssueInput = { sku: string; qty: number; offerCents?: number; agentId?: string | null };

export type IssuedQuote = Quote & {
  title: string;
  note: string; // template wording of the decision
  message: string; // reply to the buyer: LLM-drafted or template
  message_source: "gemini" | "template" | null;
  outcome: Outcome;
  negotiated: boolean;
  list_price_cents: number;
  public_reasons: string[];
  quantity_discounts: QuantityBreak[];
  market: MarketReference | null; // information only (Channel3); never used to set the price
};

/** How long an agent's earlier offers for a SKU count as the same negotiation. */
export const NEGOTIATION_WINDOW_MS = 30 * 60 * 1000;

type History = { ts: string; offerCents: number | null; unitPriceCents: number; askCents: number | null; tierPriceCents: number | null }[];
type Prepared = { product: ProductForQuote; decision: PriceDecision; history: History; breaks: QuantityBreak[] };
type Message = { text: string; source: "gemini" | "template" } | null;

/** Earlier answers this agent got for this SKU in this shop (offers only), oldest first. */
function offerHistory(db: DB, shop: Shop, sku: string, agent: string | null, now: Date): History {
  const rows = db
    .prepare("SELECT transcript_json FROM quotes WHERE shop_id = ? AND sku = ? ORDER BY rowid DESC LIMIT 200")
    .all(shop.id, sku) as { transcript_json: string }[];
  const out: History = [];
  for (const r of rows) {
    try {
      const t = JSON.parse(r.transcript_json) as Record<string, unknown>[];
      const req = t.find((e) => e.type === "request");
      const dec = t.find((e) => e.type === "decision");
      if (!req || !dec || req.offer_cents == null || (req.agent ?? null) !== agent) continue;
      const ts = String(req.ts);
      if (now.getTime() - Date.parse(ts) > NEGOTIATION_WINDOW_MS) continue;
      out.push({
        ts,
        offerCents: Number(req.offer_cents),
        unitPriceCents: Number(dec.unit_price_cents),
        askCents: dec.ask_cents == null ? null : Number(dec.ask_cents),
        tierPriceCents: dec.break_price_cents == null ? null : Number(dec.break_price_cents),
      });
    } catch {
      /* skip unreadable transcripts */
    }
  }
  return out.reverse();
}

function prepare(db: DB, shop: Shop, input: IssueInput, now: Date): Prepared {
  const product = db
    .prepare("SELECT title, price_cents, currency, stock, attrs_json FROM products WHERE shop_id = ? AND sku = ?")
    .get(shop.id, input.sku) as ProductForQuote | undefined;
  if (!product) throw new QuoteError("unknown_sku", `No product with SKU ${input.sku}.`);

  const rulesRow = db.prepare("SELECT rules_json FROM shops WHERE id = ?").get(shop.id) as { rules_json: string };
  const rules = parseRules(rulesRow.rules_json);
  checkQuantity(input.qty, product.stock, rules);
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(product.attrs_json || "{}") as Record<string, unknown>;
  } catch {
    /* no attrs */
  }
  const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const history = input.offerCents === undefined ? [] : offerHistory(db, shop, input.sku, input.agentId ?? null, now);
  const decision = decideUnitPrice({
    listPriceCents: product.price_cents,
    qty: input.qty,
    offerCents: input.offerCents,
    costCents: positive(attrs.cost_cents),
    floorCents: positive(attrs.floor_cents),
    rules,
    priorOffers: history,
  });
  return { product, decision, history, breaks: rules.quantity_breaks };
}

function persist(db: DB, shop: Shop, input: IssueInput, p: Prepared, message: Message, now: Date, secret: string, market: MarketReference | null = null): IssuedQuote {
  const { product, decision } = p;
  const fields: QuoteFields = {
    id: `q_${randomBytes(12).toString("hex")}`,
    shop: shop.slug,
    sku: input.sku,
    qty: input.qty,
    price_cents: decision.unitPriceCents,
    currency: product.currency,
    expires_at: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
  };
  const signature = signQuote(fields, secret);
  const ts = now.toISOString();
  const transcript: Record<string, unknown>[] = [
    { ts, type: "request", sku: input.sku, qty: input.qty, offer_cents: input.offerCents ?? null, agent: input.agentId ?? null },
  ];
  if (p.history.length) {
    transcript.push({
      ts,
      type: "offer_history",
      round: decision.round,
      prior: p.history.map((h) => ({ ts: h.ts, offer_cents: h.offerCents, unit_price_cents: h.unitPriceCents, ask_cents: h.askCents })),
    });
  }
  transcript.push({
    ts,
    type: "decision",
    outcome: decision.outcome,
    unit_price_cents: decision.unitPriceCents,
    list_price_cents: decision.listPriceCents,
    break_price_cents: decision.breakPriceCents,
    floor_cents: decision.floorCents,
    round: decision.round,
    ask_cents: decision.askCents,
    is_final: decision.isFinal,
    negotiated: decision.negotiated,
    reasons: decision.reasons,
    public_reasons: decision.publicReasons,
    note: decision.note,
  });
  if (market) transcript.push({ ts, ...market, type: "market_reference" });
  if (message) transcript.push({ ts, type: "message", source: message.source, text: message.text });
  db.prepare(
    `INSERT INTO quotes (id, shop_id, sku, qty, price_cents, currency, expires_at, signature, transcript_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(fields.id, shop.id, fields.sku, fields.qty, fields.price_cents, fields.currency, fields.expires_at, signature, JSON.stringify(transcript));

  return {
    ...fields,
    signature,
    total_cents: fields.price_cents * fields.qty,
    title: product.title,
    note: decision.note,
    message: message?.text ?? decision.note,
    message_source: message?.source ?? null,
    outcome: decision.outcome,
    negotiated: decision.negotiated,
    list_price_cents: decision.listPriceCents,
    public_reasons: decision.publicReasons,
    quantity_discounts: p.breaks,
    market,
  };
}

type IssueOpts = { now?: Date; secret?: string };
const factsOf = (p: Prepared, input: IssueInput, shop: Shop) => ({
  decision: p.decision,
  title: p.product.title,
  qty: input.qty,
  currency: p.product.currency,
  shopName: shop.name,
});

/** Apply policy, sign, and store a quote, with template wording. Throws PolicyError / QuoteError. */
export function issueQuote(db: DB, shop: Shop, input: IssueInput, opts: IssueOpts = {}): IssuedQuote {
  const now = opts.now ?? new Date();
  const p = prepare(db, shop, input, now);
  const message: Message = input.offerCents === undefined ? null : { text: templateMessage(factsOf(p, input, shop)), source: "template" };
  return persist(db, shop, input, p, message, now, opts.secret ?? signingSecret());
}

/**
 * Same as issueQuote, but when the buyer made an offer the reply is drafted by Gemini (if available).
 * The price is fixed before the model is asked, so the model cannot change it.
 */
export async function issueQuoteDrafted(
  db: DB,
  shop: Shop,
  input: IssueInput,
  opts: IssueOpts & { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; market?: LookupCtx } = {},
): Promise<IssuedQuote> {
  const now = opts.now ?? new Date();
  const p = prepare(db, shop, input, now);
  const message: Message =
    input.offerCents === undefined ? null : await draftMessage(db, factsOf(p, input, shop), { env: opts.env, fetchImpl: opts.fetchImpl });
  // Market reference runs only when the buyer made an offer. Its failure never blocks a quote.
  const market =
    input.offerCents === undefined ? null : await marketReference(db, p.product.title, p.product.currency, opts.market).catch(() => null);
  return persist(db, shop, input, p, message, now, opts.secret ?? signingSecret(), market);
}
