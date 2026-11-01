// Buyer-chat persistence: one conversation per (workspace, shop). The browser mirrors it in localStorage.
// Messages are stored as the client shaped them; we only bound their size and count and check shape.
import { randomUUID } from "node:crypto";
import type { DB } from "./db";

export const MAX_MESSAGES = 200;
const MAX_MESSAGE_BYTES = 20_000;
const ROLES = new Set(["you", "agent", "tool"]);

export type StoredMessage = { id: number; from: "you" | "agent" | "tool"; [k: string]: unknown };

export function loadConversation(db: DB, workspaceId: string, shopId: number): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT m.content_json FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.workspace_id = ? AND c.shop_id = ? ORDER BY m.id`,
    )
    .all(workspaceId, shopId) as { content_json: string }[];
  return rows.map((r) => JSON.parse(r.content_json) as StoredMessage);
}

/** Keep only well-formed, size-bounded messages. */
export function sanitizeMessages(input: unknown): StoredMessage[] {
  if (!Array.isArray(input)) return [];
  const out: StoredMessage[] = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.id !== "number" || !Number.isFinite(r.id) || typeof r.from !== "string" || !ROLES.has(r.from)) continue;
    if (r.from === "tool" ? typeof r.outcome !== "object" || r.outcome === null : typeof r.text !== "string") continue;
    if (JSON.stringify(m).length > MAX_MESSAGE_BYTES) continue;
    out.push(m as StoredMessage);
  }
  return out;
}

/** Replace the stored conversation. Idempotent, so the client can simply send its whole message list. */
export function saveConversation(db: DB, workspaceId: string, shopId: number, messages: StoredMessage[]): void {
  db.transaction(() => {
    const existing = db.prepare("SELECT id FROM conversations WHERE workspace_id = ? AND shop_id = ?").get(workspaceId, shopId) as
      | { id: string }
      | undefined;
    const id = existing?.id ?? randomUUID();
    if (!existing) db.prepare("INSERT INTO conversations (id, workspace_id, shop_id) VALUES (?, ?, ?)").run(id, workspaceId, shopId);
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    const ins = db.prepare("INSERT INTO messages (conversation_id, role, content_json) VALUES (?, ?, ?)");
    for (const m of messages) ins.run(id, m.from, JSON.stringify(m));
  })();
}

export type MissingRefs = { quotes: string[]; orders: string[] };

/** Quotes and orders mentioned by old tool messages that no longer exist (the DB resets on restart). */
export function findMissingRefs(db: DB, shopId: number, messages: StoredMessage[]): MissingRefs {
  const quotes = new Set<string>();
  const orders = new Set<string>();
  for (const m of messages) {
    if (m.from !== "tool") continue;
    const o = m.outcome as { tool?: string; isError?: boolean; result?: Record<string, unknown> } | undefined;
    if (!o || o.isError || !o.result) continue;
    if (o.tool === "request_quote" && typeof o.result.quote_id === "string") quotes.add(o.result.quote_id);
    if (o.tool === "create_checkout" && typeof o.result.order_id === "string") orders.add(o.result.order_id);
  }
  return {
    quotes: [...quotes].filter((id) => !db.prepare("SELECT 1 FROM quotes WHERE id = ? AND shop_id = ?").get(id, shopId)),
    orders: [...orders].filter((id) => !db.prepare("SELECT 1 FROM orders WHERE id = ? AND shop_id = ?").get(id, shopId)),
  };
}
