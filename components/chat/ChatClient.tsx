"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, useToast } from "@/components/ui";
import { weaveFor, weaveStyle } from "@/lib/design/weave";
import type { Intent, ToolOutcome } from "@/lib/chat";

type Product = { sku: string; title: string; description: string; price: string; currency: string; in_stock: boolean };
type Msg =
  | { id: number; from: "you"; text: string }
  | { id: number; from: "agent"; text: string }
  | { id: number; from: "tool"; outcome: ToolOutcome };

const SUGGESTIONS = ["wool scarf", "linen throw blanket", "something for the kitchen", "weaving kit"];
type NewMsg = Msg extends infer M ? (M extends { id: number } ? Omit<M, "id"> : never) : never;
let nextId = 1;

async function post(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

export function ChatClient() {
  const toast = useToast();
  const [msgs, setMsgs] = useState<Msg[]>([
    { id: 0, from: "agent", text: "Hi, I'm a built-in buyer agent. Tell me what you're looking for and I'll search the shop through its MCP tools, then ask for a signed quote." },
  ]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const lastQuote = useRef<string | null>(null);
  const lastOrder = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }), [msgs, busy]);

  const add = (...m: NewMsg[]) => setMsgs((cur) => [...cur, ...m.map((x) => ({ ...x, id: nextId++ }) as Msg)]);

  async function run(body: Record<string, unknown>, then?: (o: ToolOutcome) => void) {
    setBusy(true);
    try {
      const outcome = (await post(body)) as ToolOutcome;
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

  const quote = (sku: string, qty: number) =>
    run({ action: "quote", sku, qty }, (o) => {
      if (o.isError) return add({ from: "agent", text: String(o.result.message ?? "The shop declined that quote.") });
      lastQuote.current = String(o.result.quote_id);
      add({ from: "agent", text: "Here is a signed price commitment. It is valid for 10 minutes." });
    });

  const checkout = (quoteId: string) =>
    run({ action: "checkout", quote_id: quoteId }, (o) => {
      if (o.isError) return add({ from: "agent", text: String(o.result.message ?? "Checkout failed.") });
      lastOrder.current = String(o.result.order_id);
      add({ from: "agent", text: "Order created. A human has to approve the payment on the checkout page." });
    });

  async function submit(raw: string) {
    const value = raw.trim();
    if (!value || busy) return;
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
      return lastQuote.current ? checkout(lastQuote.current) : add({ from: "agent", text: "Get a quote first, then I can check out." });
    }
    if (intent.type === "status") {
      return lastOrder.current
        ? run({ action: "status", order_id: lastOrder.current })
        : add({ from: "agent", text: "No order yet in this chat." });
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
                {o.tool === "request_quote" && !o.isError && (
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
                    <div className="row">
                      <Button size="sm" disabled={busy} onClick={() => checkout(String(r.quote_id))}>Check out with PayPal</Button>
                      <Link className="btn btn-ghost btn-sm" href={`/quote/${String(r.quote_id)}`}>Inspect quote</Link>
                    </div>
                  </div>
                )}
                {o.tool === "create_checkout" && !o.isError && (
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
                {o.tool === "get_order_status" && !o.isError && (
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
        {busy && <div className="msg msg-agent"><div className="bubble"><span className="skeleton" style={{ display: "inline-block", width: 90, height: 12 }} /></div></div>}
        <div ref={endRef} />
      </div>
      <div className="row chat-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip" disabled={busy} onClick={() => submit(s)}>{s}</button>
        ))}
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void submit(text); }}>
        <label className="sr-only" htmlFor="chat-text">Message</label>
        <input id="chat-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search the shop, e.g. wool scarf" maxLength={300} autoComplete="off" />
        <Button type="submit" disabled={busy || !text.trim()}>Send</Button>
      </form>
    </div>
  );
}
