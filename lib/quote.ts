// HMAC-signed price commitments. A quote is only honoured if the stored fields still match
// the signature and it has not expired. The quote id doubles as the signed nonce.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Shop } from "./catalog";
import type { DB } from "./db";

export const QUOTE_TTL_MS = 10 * 60 * 1000;

export type QuoteFields = {
  id: string;
  shop: string; // shop slug
  sku: string;
  qty: number;
  price_cents: number; // unit price
  currency: string;
  expires_at: string; // ISO 8601
};

export type Quote = QuoteFields & { signature: string; total_cents: number };

export type QuoteErrorCode = "unknown_sku" | "unknown_quote" | "bad_signature" | "expired";

export class QuoteError extends Error {
  constructor(
    readonly code: QuoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QuoteError";
  }
}

type Env = Record<string, string | undefined>;
const g = globalThis as unknown as { __quoteloomSecret?: string };

/** QUOTE_SIGNING_SECRET if set, else a random per-process secret (quotes die on restart, like the DB). */
export function signingSecret(env: Env = process.env): string {
  if (env.QUOTE_SIGNING_SECRET) return env.QUOTE_SIGNING_SECRET;
  g.__quoteloomSecret ??= randomBytes(32).toString("hex");
  return g.__quoteloomSecret;
}

function canonical(f: QuoteFields): string {
  return JSON.stringify(["quoteloom-quote-v1", f.id, f.shop, f.sku, f.qty, f.price_cents, f.currency, f.expires_at]);
}

export function signQuote(f: QuoteFields, secret: string): string {
  return createHmac("sha256", secret).update(canonical(f)).digest("base64url");
}

export type Verdict = { ok: true } | { ok: false; code: "bad_signature" | "expired" };

export function verifyQuote(f: QuoteFields, signature: string, secret: string, now = new Date()): Verdict {
  const want = Buffer.from(signQuote(f, secret));
  const got = Buffer.from(String(signature));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, code: "bad_signature" };
  const exp = Date.parse(f.expires_at);
  if (!Number.isFinite(exp) || exp <= now.getTime()) return { ok: false, code: "expired" };
  return { ok: true };
}

// issueQuote / issueQuoteDrafted live in ./quote-issue (re-exported here for existing imports).
export { issueQuote, issueQuoteDrafted, NEGOTIATION_WINDOW_MS, type IssueInput, type IssuedQuote } from "./quote-issue";

type QuoteRow = {
  id: string;
  sku: string;
  qty: number;
  price_cents: number;
  currency: string;
  expires_at: string;
  signature: string;
};

/** Load a stored quote and verify signature and expiry against the stored fields. */
export function loadVerifiedQuote(
  db: DB,
  shop: Shop,
  quoteId: string,
  opts: { now?: Date; secret?: string } = {},
): Quote {
  const row = db
    .prepare("SELECT id, sku, qty, price_cents, currency, expires_at, signature FROM quotes WHERE id = ? AND shop_id = ?")
    .get(quoteId, shop.id) as QuoteRow | undefined;
  if (!row) throw new QuoteError("unknown_quote", "No such quote for this shop.");
  const fields: QuoteFields = {
    id: row.id,
    shop: shop.slug,
    sku: row.sku,
    qty: row.qty,
    price_cents: row.price_cents,
    currency: row.currency,
    expires_at: row.expires_at,
  };
  const verdict = verifyQuote(fields, row.signature, opts.secret ?? signingSecret(), opts.now);
  if (!verdict.ok) {
    throw new QuoteError(
      verdict.code,
      verdict.code === "expired"
        ? "This quote has expired. Request a new one."
        : "Quote signature check failed; the quote was altered.",
    );
  }
  return { ...fields, signature: row.signature, total_cents: row.price_cents * row.qty };
}

export type QuoteInspection = {
  quote: Quote;
  title: string;
  verdict: Verdict;
  transcript: unknown[];
  orderId: string | null;
};

/** Read-only look at a stored quote for the quote screen. Never throws on bad signature or expiry. */
export function inspectQuote(db: DB, quoteId: string, opts: { now?: Date; secret?: string } = {}): QuoteInspection | undefined {
  const row = db
    .prepare(
      `SELECT q.id, s.slug AS shop, q.sku, q.qty, q.price_cents, q.currency, q.expires_at, q.signature, q.transcript_json,
              COALESCE(p.title, q.sku) AS title, (SELECT id FROM orders WHERE quote_id = q.id) AS order_id
       FROM quotes q JOIN shops s ON s.id = q.shop_id
       LEFT JOIN products p ON p.shop_id = q.shop_id AND p.sku = q.sku
       WHERE q.id = ?`,
    )
    .get(quoteId) as (QuoteFields & { signature: string; transcript_json: string; title: string; order_id: string | null }) | undefined;
  if (!row) return undefined;
  const fields: QuoteFields = {
    id: row.id, shop: row.shop, sku: row.sku, qty: row.qty,
    price_cents: row.price_cents, currency: row.currency, expires_at: row.expires_at,
  };
  let transcript: unknown[] = [];
  try {
    transcript = JSON.parse(row.transcript_json) as unknown[];
  } catch {
    /* leave empty */
  }
  return {
    quote: { ...fields, signature: row.signature, total_cents: row.price_cents * row.qty },
    title: row.title,
    verdict: verifyQuote(fields, row.signature, opts.secret ?? signingSecret(), opts.now),
    transcript,
    orderId: row.order_id,
  };
}
