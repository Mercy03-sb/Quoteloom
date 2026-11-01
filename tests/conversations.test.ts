import { describe, expect, it } from "vitest";
import { findMissingRefs, loadConversation, sanitizeMessages, saveConversation, type StoredMessage } from "@/lib/conversations";
import { createCheckout } from "@/lib/orders";
import { issueQuote } from "@/lib/quote";
import { seed } from "@/lib/seed";
import { resolveWorkspace } from "@/lib/workspace";
import { seededDb } from "./helpers";

const tool = (name: string, result: Record<string, unknown>, isError = false): StoredMessage => ({
  id: 1,
  from: "tool",
  outcome: { tool: name, args: {}, isError, result },
});

describe("conversation storage", () => {
  it("round-trips messages and replaces them idempotently", () => {
    const { db, shop } = seededDb();
    const ws = resolveWorkspace(db, new Headers()).id;
    const msgs: StoredMessage[] = [{ id: 0, from: "agent", text: "hi" }, { id: 1, from: "you", text: "wool scarf" }];
    saveConversation(db, ws, shop.id, msgs);
    saveConversation(db, ws, shop.id, msgs);
    expect(loadConversation(db, ws, shop.id)).toEqual(msgs);
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n).toBe(1);
    saveConversation(db, ws, shop.id, [msgs[0]]);
    expect(loadConversation(db, ws, shop.id)).toEqual([msgs[0]]);
  });

  it("drops malformed and oversized messages, and caps the count", () => {
    const ok = { id: 1, from: "you", text: "x" };
    const out = sanitizeMessages([ok, null, 5, { id: "1", from: "you", text: "x" }, { id: 2, from: "root", text: "x" }, { id: 3, from: "you" }, { id: 4, from: "tool" }, { id: 5, from: "you", text: "y".repeat(30_000) }]);
    expect(out).toEqual([ok]);
    expect(sanitizeMessages("nope")).toEqual([]);
    expect(sanitizeMessages(Array.from({ length: 500 }, (_, i) => ({ id: i, from: "you", text: "x" })))).toHaveLength(200);
  });

  it("is removed with the seed (restart resets the demo)", () => {
    const { db, shop } = seededDb();
    const ws = resolveWorkspace(db, new Headers()).id;
    saveConversation(db, ws, shop.id, [{ id: 0, from: "you", text: "x" }]);
    seed(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0);
  });
});

describe("missing quote and order references", () => {
  it("reports quotes and orders that no longer exist, and keeps those that do", async () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 }, { secret: "s" });
    const c = await createCheckout(db, shop, q.id, "http://localhost:3000", { secret: "s", env: {} });
    const msgs = [
      tool("request_quote", { quote_id: q.id }),
      tool("request_quote", { quote_id: "gone-quote" }),
      tool("create_checkout", { order_id: c.order_id }),
      tool("create_checkout", { order_id: "gone-order" }),
      tool("request_quote", { quote_id: "errored-quote" }, true), // failed calls have nothing to be missing
      tool("search_products", { count: 0 }),
    ];
    expect(findMissingRefs(db, shop.id, msgs)).toEqual({ quotes: ["gone-quote"], orders: ["gone-order"] });
  });

  it("after a restart (seed) every old reference is reported missing", async () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 }, { secret: "s" });
    seed(db);
    const demo = db.prepare("SELECT id FROM shops").get() as { id: number };
    expect(findMissingRefs(db, demo.id, [tool("request_quote", { quote_id: q.id })])).toEqual({ quotes: [q.id], orders: [] });
  });

  it("does not treat another shop quote as available", () => {
    const { db, shop } = seededDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 }, { secret: "s" });
    expect(findMissingRefs(db, shop.id + 1, [tool("request_quote", { quote_id: q.id })]).quotes).toEqual([q.id]);
  });
});
