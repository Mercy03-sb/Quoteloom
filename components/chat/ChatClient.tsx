"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, useToast } from "@/components/ui";
import { weaveFor, weaveStyle } from "@/lib/design/weave";
import type { Intent, ToolOutcome } from "@/lib/chat";
import { NegotiationResult, OfferPanel } from "./OfferPanel";

type Product = { sku: string; title: string; description: string; price: string; currency: string; in_stock: boolean };
type Msg =
  | { id: number; from: "you"; text: string }
  | { id: number; from: "agent"; text: string }
  | { id: number; from: "tool"; outcome: ToolOutcome };

const GREETING: Msg = {
  id: 0,
  from: "agent",
  text: "Hi, I'm a built-in buyer agent. Tell me what you're looking for and I'll search the shop through its MCP tools, then ask for a signed quote.",
};
type Missing = { quotes: string[]; orders: string[] };
const NO_MISSING: Missing = { quotes: [], orders: [] };
const MAX_STORED = 200;

function readLocal(key: string): Msg[] {
  try {
    const raw = window.localStorage.getItem(key);
    const data = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(data) ? (data as Msg[]).filter((m) => m && typeof m.id === "number" && typeof m.from === "string") : [];
  } catch {
    return [];
  }
}

function writeLocal(key: string, msgs: Msg[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(msgs.slice(-MAX_STORED)));
  } catch {
    /* storage full or blocked: the server copy still works */
  }
}

/** Shown in place of a quote or order card whose record is gone (the demo DB resets on restart). */
function Unavailable({ what }: { what: "quote" | "order" }) {
  return (
    <div className="notice" data-tone="warning" role="status" data-testid={`${what}-unavailable`}>
      This {what} is no longer available. The demo database resets when the server restarts, so ask for a new one.
    </div>
  );
}

const SUGGESTIONS = ["wool scarf", "linen throw blanket", "something for the kitchen", "weaving kit"];
type NewMsg = Msg extends infer M ? (M extends { id: number } ? Omit<M, "id"> : never) : never;
let nextId = 1;

async function post(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 429) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? "Too many requests. Please wait a moment.");
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (left === null) return null;
  if (left === 0) return <Badge tone="danger" dot>Expired</Badge>;
  return <Badge tone="warning" dot>Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</Badge>;
}

function ToolCall({ outcome }: { outcome: ToolOutcome }) {
  return (
    <details className="toolcall" data-error={outcome.isError}>
      <summary>
        <span className="toolcall-name">{outcome.tool}</span>
        <code>{JSON.stringify(outcome.args)}</code>
        <Badge tone={outcome.isError ? "danger" : "success"}>{outcome.isError ? "error" : "ok"}</Badge>
      </summary>
      <pre>{JSON.stringify(outcome.result, null, 2)}</pre>
    </details>
  );
}

export function ChatClient({ shopSlug }: { shopSlug: string }) {
  const toast = useToast();
  const storageKey = `ql-chat:${shopSlug}`;
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [missing, setMissing] = useState<Missing>(NO_MISSING);
  const [restoring, setRestoring] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Restore on load: the server copy (per workspace) wins; localStorage is the mirror used if the server has none.
  useEffect(() => {
    let cancelled = false;
    const local = readLocal(storageKey);
    if (local.length) {
      nextId = Math.max(nextId, ...local.map((m) => m.id + 1));
      setMsgs(local);
    }
    (async () => {
      try {
        const res = await fetch(`/api/conversation?shop=${encodeURIComponent(shopSlug)}`);
        if (!res.ok) throw new Error("restore failed");
        const data = (await res.json()) as { messages: Msg[]; missing: Missing };
        if (cancelled) return;
        if (data.messages.length) {
          nextId = Math.max(nextId, ...data.messages.map((m) => m.id + 1));
          setMsgs(data.messages);
          setMissing(data.missing);
        } else if (local.length) {
          const put = await fetch("/api/conversation", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ shop: shopSlug, messages: local }),
          });
          if (put.ok && !cancelled) setMissing(((await put.json()) as { missing: Missing }).missing);
        }
      } catch {
        /* offline or server reset: keep whatever localStorage gave us */
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopSlug, storageKey]);

  // Persist after every change: localStorage immediately, server shortly after (debounced).
  useEffect(() => {
    if (restoring) return;
    writeLocal(storageKey, msgs);
    const t = setTimeout(() => {
      fetch("/api/conversation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shop: shopSlug, messages: msgs.slice(-MAX_STORED) }),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [msgs, restoring, shopSlug, storageKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [msgs, busy]);

  /** Newest successful result of a tool, ignoring ids whose records no longer exist. */
  const latest = (tool: string, field: string, gone: string[]): string | null => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.from === "tool" && m.outcome.tool === tool && !m.outcome.isError) {
        const id = String(m.outcome.result[field]);
        return gone.includes(id) ? null : id;
      }
    }
    return null;
  };

  function newConversation() {
    nextId = 1;
    setMissing(NO_MISSING);
    setMsgs([GREETING]);
  }

  const add = (...m: NewMsg[]) => setMsgs((cur) => [...cur, ...m.map((x) => ({ ...x, id: nextId++ }) as Msg)]);

  async function run(body: Record<string, unknown>, then?: (o: ToolOutcome) => void) {
    setBusy(true);
    try {
      const outcome = (await post({ ...body, shop: shopSlug })) as ToolOutcome;
      add({ from: "tool", outcome });
      then?.(outcome);
    } catch (e) {
      toast((e as Error).message, "danger");
      add({ from: "agent", text: "Something went wrong reaching the shop. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const search = (query: string) =>
    run({ action: "search", query }, (o) => {
      const n = Number(o.result.count ?? 0);
      add({ from: "agent", text: n ? `Found ${n} product${n === 1 ? "" : "s"}. Pick one to get a signed quote.` : "Nothing matched. Try different words." });
    });

  const quote = (sku: string, qty: number, offer?: number) =>
    run({ action: "quote", sku, qty, ...(offer === undefined ? {} : { offer_price: offer }) }, (o) => {
      if (o.isError) return add({ from: "agent", text: String(o.result.message ?? "The shop declined that quote.") });
      const n = o.result.negotiation as { outcome?: string } | undefined;
      add({
        from: "agent",
        text:
          offer === undefined
            ? "Here is a signed price commitment. It is valid for 10 minutes."
            : n?.outcome === "accepted"
              ? "The shop accepted your offer. Here is the new signed quote, valid for 10 minutes."
              : n?.outcome === "countered" || n?.outcome === "round_limit"
                ? "The shop answered with its best price. Here is the new signed quote, valid for 10 minutes."
                : "Here is a new signed quote. It is valid for 10 minutes.",
      });
    });

  const newestQuoteId = latest("request_quote", "quote_id", missing.quotes);

  const checkout = (quoteId: string) =>
    run({ action: "checkout", quote_id: quoteId }, (o) => {
      if (o.isError) return add({ from: "agent", text: String(o.result.message ?? "Checkout failed.") });
      add({ from: "agent", text: "Order created. A human has to approve the payment on the checkout page." });
    });

  async function submit(raw: string) {
    const value = raw.trim();
    if (!value || busy || restoring) return;
    setText("");
    add({ from: "you", text: value });
    let intent: Intent;
    try {
      intent = ((await post({ action: "parse", text: value })) as { intent: Intent }).intent;
    } catch {
      return add({ from: "agent", text: "I could not reach the shop. Please try again." });
    }
    if (intent.type === "search") return search(intent.query);
    if (intent.type === "quote") return quote(intent.sku, intent.qty);
    if (intent.type === "checkout") {
      const q = latest("request_quote", "quote_id", missing.quotes);
      return q ? checkout(q) : add({ from: "agent", text: "Get a quote first, then I can check out." });
    }
    if (intent.type === "status") {
      const ord = latest("create_checkout", "order_id", missing.orders);
      return ord ? run({ action: "status", order_id: ord }) : add({ from: "agent", text: "No order yet in this chat." });
    }
    add({ from: "agent", text: "Try: \"wool scarf\", then pick a product. You can also type \"quote 2 LT-SCARF-WOOL-GRY\" or \"buy\"." });
  }

  return (
    <div className="chat">
      <div className="chat-log" role="log" aria-live="polite" aria-label="Conversation">
        {msgs.map((m) => {
          if (m.from === "tool") {
            const o = m.outcome;
            const r = o.result;
            return (
              <div key={m.id} className="msg msg-tool">
                <ToolCall outcome={o} />
                {o.tool === "search_products" && Array.isArray(r.results) && (
                  <div className="chat-products">
                    {(r.results as Product[]).map((p) => (
                      <div key={p.sku} className="chat-product">
                        <div className="chat-swatch" style={weaveStyle(weaveFor(p))} aria-hidden="true" />
                        <div className="chat-product-body">
                          <strong>{p.title}</strong>
                          <span className="stat-note">{p.sku}</span>
                          <span className="price">{p.price} {p.currency}</span>
                        </div>
                        <Button size="sm" variant="secondary" disabled={busy || !p.in_stock} onClick={() => quote(p.sku, 1)}>
                          {p.in_stock ? "Get quote" : "Sold out"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {o.tool === "request_quote" && !o.isError && missing.quotes.includes(String(r.quote_id)) && <Unavailable what="quote" />}
                {o.tool === "request_quote" && !o.isError && !missing.quotes.includes(String(r.quote_id)) && (
                  <div className="quote-card">
                    <div className="card-head">
                      <h3>{String(r.title)}</h3>
                      <Countdown expiresAt={String(r.expires_at)} />
                    </div>
                    <div className="kv">
                      <span>Quantity</span><b>{String(r.qty)}</b>
                      <span>Unit price</span><b>{String(r.unit_price)} {String(r.currency)}</b>
                      <span>Total</span><b>{String(r.total)} {String(r.currency)}</b>
                      <span>Signature</span><code className="sig">{String(r.signature).slice(0, 22)}…</code>
                    </div>
                    <NegotiationResult r={r} />
                    {String(r.quote_id) === newestQuoteId && (
                      <OfferPanel key={String(r.quote_id)} r={r} busy={busy} onSubmit={(qty, offer) => quote(String(r.sku), qty, offer)} />
                    )}
                    <div className="row">
                      <Button size="sm" disabled={busy} onClick={() => checkout(String(r.quote_id))}>Check out with PayPal</Button>
                      <Link className="btn btn-ghost btn-sm" href={`/quote/${String(r.quote_id)}`}>Inspect quote</Link>
                    </div>
                  </div>
                )}
                {o.tool === "create_checkout" && !o.isError && missing.orders.includes(String(r.order_id)) && <Unavailable what="order" />}
                {o.tool === "create_checkout" && !o.isError && !missing.orders.includes(String(r.order_id)) && (
                  <div className="quote-card">
                    <div className="card-head">
                      <h3>Order ready</h3>
                      <Badge tone="warning" dot>{String(r.status)}</Badge>
                    </div>
                    <p className="stat-note" style={{ marginBottom: "var(--sp-3)" }}>
                      Total {String(r.total)} {String(r.currency)} · {String(r.mode) === "simulation" ? "simulated PayPal" : "PayPal sandbox"}
                    </p>
                    <a className="btn btn-primary btn-sm" href={String(r.approval_url)}>Open checkout to pay</a>
                  </div>
                )}
                {o.tool === "get_order_status" && !o.isError && !missing.orders.includes(String(r.order_id)) && (
                  <p className="stat-note">Order {String(r.order_id)} is <b>{String(r.status)}</b>.</p>
                )}
              </div>
            );
          }
          return (
            <div key={m.id} className={`msg msg-${m.from}`}>
              <div className="bubble">{m.text}</div>
            </div>
          );
        })}
        {restoring && <p className="stat-note" role="status">Restoring your conversation…</p>}
        {busy && <div className="msg msg-agent"><div className="bubble"><span className="skeleton" style={{ display: "inline-block", width: 90, height: 12 }} /></div></div>}
        <div ref={endRef} />
      </div>
      <div className="row chat-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip" disabled={busy || restoring} onClick={() => submit(s)}>{s}</button>
        ))}
        <button type="button" className="chip chip-quiet" disabled={busy || restoring || msgs.length <= 1} onClick={newConversation}>New conversation</button>
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void submit(text); }}>
        <label className="sr-only" htmlFor="chat-text">Message</label>
        <input id="chat-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search the shop, e.g. wool scarf" maxLength={300} autoComplete="off" />
        <Button type="submit" disabled={busy || restoring || !text.trim()}>Send</Button>
      </form>
    </div>
  );
}
