import { describe, expect, it } from "vitest";
import {
  inspectQuote,
  issueQuote,
  loadVerifiedQuote,
  QUOTE_TTL_MS,
  QuoteError,
  signQuote,
  verifyQuote,
  type QuoteFields,
} from "@/lib/quote";
import { seededDb } from "./helpers";

const SECRET = "test-secret";
const now = new Date("2026-11-01T10:00:00Z");
const fields: QuoteFields = {
  id: "q_1",
  shop: "loom-and-thread",
  sku: "A",
  qty: 2,
  price_cents: 1000,
  currency: "USD",
  expires_at: "2026-11-01T10:10:00.000Z",
};

describe("verifyQuote", () => {
  const sig = signQuote(fields, SECRET);
  it("accepts an untouched, unexpired quote", () => {
    expect(verifyQuote(fields, sig, SECRET, now)).toEqual({ ok: true });
  });
  it.each([
    ["price", { price_cents: 1 }],
    ["qty", { qty: 20 }],
    ["sku", { sku: "B" }],
    ["currency", { currency: "EUR" }],
    ["shop", { shop: "other" }],
    ["id", { id: "q_2" }],
    ["expiry", { expires_at: "2099-01-01T00:00:00.000Z" }],
  ])("rejects a tampered %s", (_n, change) => {
    expect(verifyQuote({ ...fields, ...change }, sig, SECRET, now)).toEqual({ ok: false, code: "bad_signature" });
  });
  it("rejects a wrong secret and garbage signatures", () => {
    expect(verifyQuote(fields, sig, "other", now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyQuote(fields, "", SECRET, now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyQuote(fields, "x".repeat(sig.length), SECRET, now)).toMatchObject({ ok: false, code: "bad_signature" });
  });
  it("rejects an expired quote (and exactly at expiry)", () => {
    expect(verifyQuote(fields, sig, SECRET, new Date("2026-11-01T10:10:00.001Z"))).toEqual({ ok: false, code: "expired" });
    expect(verifyQuote(fields, sig, SECRET, new Date("2026-11-01T10:10:00.000Z"))).toEqual({ ok: false, code: "expired" });
  });
});

describe("issueQuote", () => {
  it("quotes list price with a 10 minute expiry and stores it", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 2 }, { now, secret: SECRET });
    expect(q.price_cents).toBe(4800);
    expect(q.total_cents).toBe(9600);
    expect(Date.parse(q.expires_at) - now.getTime()).toBe(QUOTE_TTL_MS);
    expect(loadVerifiedQuote(db, shop, q.id, { now, secret: SECRET }).signature).toBe(q.signature);
  });
  it("ignores a lower offer", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1, offerCents: 100 }, { now, secret: SECRET });
    expect(q.price_cents).toBe(4800);
  });
  it("rejects unknown SKUs and policy violations", () => {
    const { db, shop } = seededDb();
    expect(() => issueQuote(db, shop, { sku: "NOPE", qty: 1 }, { secret: SECRET })).toThrowError(
      expect.objectContaining({ code: "unknown_sku" }),
    );
    expect(() => issueQuote(db, shop, { sku: "LT-RUG-WOOL-SM", qty: 4 }, { secret: SECRET })).toThrowError(
      expect.objectContaining({ code: "insufficient_stock" }),
    );
    expect(() => issueQuote(db, shop, { sku: "LT-TOTE-CANVAS", qty: 21 }, { secret: SECRET })).toThrowError(
      expect.objectContaining({ code: "quantity_too_large" }),
    );
  });
});

describe("loadVerifiedQuote", () => {
  const issue = () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 }, { now, secret: SECRET });
    return { db, shop, q };
  };
  it("rejects an expired quote", () => {
    const { db, shop, q } = issue();
    const later = new Date(now.getTime() + QUOTE_TTL_MS + 1);
    expect(() => loadVerifiedQuote(db, shop, q.id, { now: later, secret: SECRET })).toThrowError(
      expect.objectContaining({ code: "expired" }),
    );
  });
  it.each([
    ["price", "price_cents = 1"],
    ["qty", "qty = 9"],
    ["expiry", "expires_at = '2099-01-01T00:00:00.000Z'"],
    ["signature", "signature = 'AAAA'"],
  ])("rejects a quote whose stored %s was tampered", (_n, set) => {
    const { db, shop, q } = issue();
    db.prepare(`UPDATE quotes SET ${set} WHERE id = ?`).run(q.id);
    expect(() => loadVerifiedQuote(db, shop, q.id, { now, secret: SECRET })).toThrowError(
      expect.objectContaining({ code: "bad_signature" }),
    );
  });
  it("rejects unknown quotes and quotes from another shop", () => {
    const { db, shop, q } = issue();
    expect(() => loadVerifiedQuote(db, shop, "q_missing", { secret: SECRET })).toThrow(QuoteError);
    expect(() => loadVerifiedQuote(db, { ...shop, id: 999 }, q.id, { secret: SECRET })).toThrowError(
      expect.objectContaining({ code: "unknown_quote" }),
    );
  });
  it("inspectQuote reports the verdict without throwing", () => {
    const { db, q } = issue();
    expect(inspectQuote(db, q.id, { now, secret: SECRET })?.verdict).toEqual({ ok: true });
    db.prepare("UPDATE quotes SET price_cents = 1 WHERE id = ?").run(q.id);
    expect(inspectQuote(db, q.id, { now, secret: SECRET })?.verdict).toMatchObject({ ok: false, code: "bad_signature" });
    expect(inspectQuote(db, "nope")).toBeUndefined();
  });
});
