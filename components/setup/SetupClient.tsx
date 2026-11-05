"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/catalog/CopyButton";
import { Badge, Button, Card, EmptyState, useToast } from "@/components/ui";
import { findProblems, type DraftProduct } from "@/lib/ingest/draft";
import type { IngestResult, StepEvent, StepId } from "@/lib/ingest/pipeline";
import { ReviewGrid, type DraftRow } from "./ReviewGrid";

type Phase = "idle" | "running" | "review" | "published";
type Mode = "url" | "csv";
type IngestEvent = { type: "step" } & StepEvent | { type: "result"; result: IngestResult } | { type: "error"; message: string };
type Published = { slug: string; mcp_url: string; products: number; name: string };

const URL_STEPS: { id: StepId; label: string }[] = [
  { id: "validate", label: "Checking the address" },
  { id: "fetch", label: "Fetching the page" },
  { id: "discover", label: "Finding product pages" },
  { id: "pages", label: "Reading product pages" },
  { id: "extract", label: "Extracting products" },
  { id: "draft", label: "Building the draft catalog" },
];
const CSV_STEPS: { id: StepId; label: string }[] = [
  { id: "fetch", label: "Reading the CSV" },
  { id: "draft", label: "Building the draft catalog" },
];
const DEMO_STORES = [
  { path: "/demo-shops/clay-and-kiln", label: "Clay & Kiln", hint: "JSON-LD" },
  { path: "/demo-shops/daily-grind", label: "Daily Grind", hint: "JSON-LD" },
  { path: "/demo-shops/sunday-market", label: "Sunday Market", hint: "no structured data" },
];
const MAX_CSV_BYTES = 1_000_000;

let rowCounter = 0;
const withIds = (products: DraftProduct[]): DraftRow[] => products.map((p) => ({ ...p, _id: `r${++rowCounter}` }));

/** Read newline-delimited JSON events from a streaming response. */
async function readEvents(res: Response, onEvent: (e: IngestEvent) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body.");
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as IngestEvent);
    }
    if (done) break;
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as IngestEvent);
}

export function SetupClient({ shopCount, maxShops }: { shopCount: number; maxShops: number }) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("url");
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [steps, setSteps] = useState<Partial<Record<StepId, StepEvent>>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [name, setName] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<Published | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => () => abortRef.current?.abort(), []);

  const problems = useMemo(() => findProblems(rows), [rows]);
  const problemCount = Object.keys(problems).length;
  const canPublish = rows.length > 0 && problemCount === 0 && name.trim().length > 0 && !publishing;
  const stepList = mode === "csv" ? CSV_STEPS : URL_STEPS;
  const full = shopCount >= maxShops;

  function reset() {
    abortRef.current?.abort();
    setPhase("idle");
    setSteps({});
    setError(null);
    setResult(null);
    setRows([]);
    setPublished(null);
  }

  async function start(payload: { url: string } | { csv: string }) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("running");
    setSteps({});
    setError(null);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(res.status === 429 ? (data.message ?? "Too many requests. Please wait a moment.") : (data.message ?? `Request failed (${res.status}).`));
      }
      let finished = false;
      await readEvents(res, (e) => {
        if (e.type === "step") setSteps((s) => ({ ...s, [e.id]: e }));
        else if (e.type === "error") throw new Error(e.message);
        else {
          finished = true;
          setResult(e.result);
          setRows(withIds(e.result.products));
          setName(e.result.shopName);
          setPhase("review");
        }
      });
      if (!finished) throw new Error("The connection ended before the catalog was ready.");
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError((e as Error).message || "Something went wrong.");
      setPhase("idle");
    }
  }

  function submitUrl(value = url) {
    const v = value.trim();
    if (!v) return setError("Paste a shop URL first.");
    setMode("url");
    void start({ url: v });
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) return setError("That file is larger than 1 MB. Split it and try again.");
    setMode("csv");
    void start({ csv: await file.text() });
  }

  async function publish() {
    setPublishing(true);
    try {
      const res = await fetch("/api/shops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          source_url: result?.sourceUrl || null,
          products: rows.map((r) => ({ sku: r.sku, title: r.title, description: r.description, price_cents: r.price_cents, currency: r.currency, stock: r.stock })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<Published> & { message?: string };
      if (!res.ok || !data.slug || !data.mcp_url) throw new Error(data.message ?? `Publish failed (${res.status}).`);
      setPublished({ slug: data.slug, mcp_url: data.mcp_url, products: data.products ?? rows.length, name: data.name ?? name });
      setPhase("published");
      toast("Shop published", "success");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setPublishing(false);
    }
  }

  const addRow = () => setRows((r) => [...r, ...withIds([{ sku: "", title: "", description: "", price_cents: 0, currency: "USD", stock: 10 }])]);

  // ---------- published ----------
  if (phase === "published" && published) {
    return (
      <div className="stack-lg">
        <Card hero>
          <div className="row" style={{ marginBottom: "var(--sp-3)" }}>
            <Badge tone="success" dot>Published</Badge>
            <Badge>{published.products} products</Badge>
          </div>
          <h2>{published.name} is live</h2>
          <p style={{ color: "var(--c-text-muted)", margin: "var(--sp-2) 0 var(--sp-5)", maxWidth: "58ch" }}>
            Point any MCP client at this URL. Buyer agents can search, get signed quotes and check out with PayPal sandbox.
          </p>
          <div className="endpoint">
            <code data-testid="mcp-url">{published.mcp_url}</code>
            <CopyButton text={published.mcp_url} label="Copy URL" />
          </div>
        </Card>
        <div className="row">
          <Link className="btn btn-primary" href={`/playground?shop=${published.slug}`}>Try it in the agent playground</Link>
          <Link className="btn btn-secondary" href={`/?shop=${published.slug}`}>Open dashboard</Link>
          <Link className="btn btn-secondary" href={`/catalog?shop=${published.slug}`}>View catalog</Link>
          <Button variant="ghost" onClick={reset}>Set up another shop</Button>
        </div>
      </div>
    );
  }

  // ---------- review ----------
  if (phase === "review" && result) {
    return (
      <div className="stack-lg">
        <Card>
          <div className="card-head card-head-tight">
            <h3>Review your draft catalog</h3>
            <div className="row">
              <Badge tone="accent">{rows.length} product{rows.length === 1 ? "" : "s"}</Badge>
              {result.methods.jsonld > 0 && <Badge>{result.methods.jsonld} from JSON-LD</Badge>}
              {result.methods.opengraph > 0 && <Badge>{result.methods.opengraph} from Open Graph</Badge>}
              {result.methods.llm > 0 && <Badge>{result.methods.llm} via Gemini</Badge>}
              {result.methods.rules > 0 && <Badge>{result.methods.rules} via rule-based parser</Badge>}
            </div>
          </div>
          <p className="stat-note" style={{ margin: 0, marginBottom: "var(--sp-2)" }}>
            Click any cell to edit. Prices are shown in major units (12.50). Outlined cells need fixing before you can publish.
          </p>
          {result.warnings.map((w) => (
            <div key={w} className="notice" data-tone="warning" style={{ marginBottom: "var(--sp-2)" }}>{w}</div>
          ))}
        </Card>

        {rows.length === 0 ? (
          <EmptyState
            title="No products in the draft"
            action={<div className="row"><Button onClick={addRow}>Add a product</Button><Button variant="secondary" onClick={reset}>Start over</Button></div>}
          >
            Nothing was found, or you deleted every row. Add products by hand, try another page, or upload a CSV.
          </EmptyState>
        ) : (
          <ReviewGrid
            rows={rows}
            onChange={(row) => setRows((cur) => cur.map((r) => (r._id === row._id ? row : r)))}
            onDelete={(id) => setRows((cur) => cur.filter((r) => r._id !== id))}
          />
        )}

        <Card flat>
          <div className="publish-bar">
            <label className="field">
              <span>Shop name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="My shop" />
            </label>
            <div className="row">
              <Button variant="secondary" onClick={addRow} disabled={rows.length >= 200}>Add row</Button>
              <Button variant="ghost" onClick={reset}>Start over</Button>
              <Button onClick={publish} disabled={!canPublish}>{publishing ? "Publishing…" : "Publish shop"}</Button>
            </div>
          </div>
          {problemCount > 0 && (
            <p className="stat-note" role="status" style={{ marginTop: "var(--sp-2)" }}>
              {problemCount} row{problemCount === 1 ? " needs" : "s need"} fixing before you can publish.
            </p>
          )}
        </Card>
      </div>
    );
  }

  // ---------- idle / running ----------
  const running = phase === "running";
  const active = stepList.findIndex((s) => !steps[s.id] || steps[s.id]?.status === "running");
  return (
    <div className="stack-lg">
      <div className="notice" data-tone="warning" role="note">
        <strong>Only ingest sites you own or have permission to use.</strong> Quoteloom fetches the page and up to 20 linked pages on the same site, and
        never stores anything except the draft you publish.
      </div>

      {full && (
        <div className="notice" data-tone="danger" role="alert">
          This workspace already has {maxShops} shops, the demo limit. Publishing another will be refused.
        </div>
      )}

      <Card>
        <div className="segmented" role="group" aria-label="Source">
          <button type="button" aria-pressed={mode === "url"} onClick={() => setMode("url")} disabled={running}>From a URL</button>
          <button type="button" aria-pressed={mode === "csv"} onClick={() => setMode("csv")} disabled={running}>From a CSV</button>
        </div>

        {mode === "url" ? (
          <form className="stack" style={{ marginTop: "var(--sp-4)" }} onSubmit={(e) => { e.preventDefault(); submitUrl(); }}>
            <label className="field">
              <span>Shop URL</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example-shop.com/products" inputMode="url" autoComplete="off" disabled={running} />
            </label>
            <div className="row">
              <Button type="submit" disabled={running || !url.trim()}>{running ? "Working…" : "Build my catalog"}</Button>
            </div>
            <div className="stack">
              <span className="stat-note">No site handy? Try one of our fake demo stores:</span>
              <div className="row">
                {DEMO_STORES.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    className="chip"
                    disabled={running || !origin}
                    onClick={() => { const u = origin + d.path; setUrl(u); submitUrl(u); }}
                  >
                    {d.label} <span className="stat-note">({d.hint})</span>
                  </button>
                ))}
              </div>
            </div>
          </form>
        ) : (
          <div className="stack" style={{ marginTop: "var(--sp-4)" }}>
            <label className="dropzone" data-disabled={running}>
              <input type="file" accept=".csv,text/csv" disabled={running} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
              <strong>Choose a CSV file</strong>
              <span className="stat-note">Columns: sku, title, description, price, currency, stock (title and price are required). Up to 1 MB and 200 rows.</span>
            </label>
            <a className="btn btn-ghost btn-sm" href="/sample-products.csv" download>Download the sample CSV</a>
          </div>
        )}
      </Card>

      {error && (
        <div className="error-box" role="alert">
          <strong>Could not build the catalog</strong>
          <span>{error}</span>
          <Button variant="secondary" size="sm" onClick={() => setError(null)}>Dismiss</Button>
        </div>
      )}

      {running && (
        <Card title="Building your catalog" action={<Button variant="ghost" size="sm" onClick={reset}>Cancel</Button>}>
          <ol className="steps" aria-live="polite">
            {stepList.map((s, i) => {
              const ev = steps[s.id];
              const done = ev?.status === "done" || ev?.status === "warn";
              return (
                <li key={s.id} data-done={done} data-current={i === active} data-error={ev?.status === "error"}>
                  <span>
                    {s.label}
                    {ev?.detail && <span className="stat-note"> · {ev.detail}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}
