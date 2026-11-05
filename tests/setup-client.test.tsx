// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestResult } from "@/lib/ingest/pipeline";

// The editable AG Grid is covered in review-grid.test.tsx; here it is a plain stub so we can test the flow around it.
vi.mock("@/components/setup/ReviewGrid", () => ({
  ReviewGrid: ({ rows, onChange, onDelete }: { rows: { _id: string; title: string; price_cents: number }[]; onChange: (r: unknown) => void; onDelete: (id: string) => void }) => (
    <ul data-testid="grid">
      {rows.map((r) => (
        <li key={r._id}>
          <span>{r.title || "(untitled)"}</span>
          <button onClick={() => onChange({ ...r, price_cents: 1234 })}>fix {r._id}</button>
          <button onClick={() => onDelete(r._id)}>delete {r._id}</button>
        </li>
      ))}
    </ul>
  ),
}));

import { SetupClient } from "@/components/setup/SetupClient";

const result = (over: Partial<IngestResult> = {}): IngestResult => ({
  shopName: "Clay Shop",
  sourceUrl: "https://clay.example/",
  products: [
    { sku: "A", title: "Mug", description: "", price_cents: 2400, currency: "USD", stock: 5 },
    { sku: "B", title: "Bowl", description: "", price_cents: 0, currency: "USD", stock: 5 },
  ],
  methods: { jsonld: 2, opengraph: 0, llm: 0, rules: 0 },
  warnings: ["1 product has no price. Fix them in the table before publishing."],
  ...over,
});

function ndjson(events: unknown[], delayEnd = false): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      events.forEach((e) => c.enqueue(enc.encode(JSON.stringify(e) + "\n")));
      if (!delayEnd) c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
const step = (id: string, status = "done", detail?: string) => ({ type: "step", id, label: id, status, detail });
const mockFetch = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>) => vi.stubGlobal("fetch", vi.fn((u: string, i?: RequestInit) => Promise.resolve(fn(u, i))));
const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];

beforeEach(() => {
  Element.prototype.scrollIntoView = (() => {}) as Element["scrollIntoView"];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const startUrl = async (url = "https://clay.example/") => {
  fireEvent.change(screen.getByLabelText("Shop URL"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Build my catalog" }));
};

describe("SetupClient", () => {
  it("idle state: ownership notice, URL form, demo stores, and a CSV tab with a sample download", () => {
    render(<SetupClient shopCount={0} maxShops={5} />);
    expect(screen.getByRole("note").textContent).toMatch(/Only ingest sites you own or have permission to use/);
    expect((screen.getByRole("button", { name: "Build my catalog" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Sunday Market/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "From a CSV" }));
    expect(screen.getByText("Choose a CSV file")).toBeTruthy();
    expect(screen.getByRole("link", { name: /sample CSV/ }).getAttribute("href")).toBe("/sample-products.csv");
  });

  it("warns when the workspace is at its shop limit", () => {
    render(<SetupClient shopCount={5} maxShops={5} />);
    expect(screen.getByRole("alert").textContent).toMatch(/already has 5 shops/);
  });

  it("shows step-by-step progress while the server works, then the review screen", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mockFetch(() => {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(JSON.stringify(step("validate", "done", "clay.example")) + "\n"));
          c.enqueue(enc.encode(JSON.stringify(step("fetch", "running")) + "\n"));
          await gate;
          c.enqueue(enc.encode(JSON.stringify({ type: "result", result: result() }) + "\n"));
          c.close();
        },
      });
      return new Response(stream);
    });
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    expect(await screen.findByText("Building your catalog")).toBeTruthy();
    await screen.findByText(/clay\.example/);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(6);
    release();
    expect(await screen.findByText("Review your draft catalog")).toBeTruthy();
    expect(JSON.parse(calls()[0][1].body as string)).toEqual({ url: "https://clay.example/" });
  });

  it("review: fixing the price enables Publish; publishing shows the MCP URL with a copy button", async () => {
    mockFetch((url) =>
      url === "/api/ingest"
        ? ndjson([{ type: "result", result: result() }])
        : new Response(JSON.stringify({ slug: "clay-shop", name: "Clay Shop", products: 2, mcp_url: "http://localhost:3000/m/clay-shop/mcp" }), { status: 201 }),
    );
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    await screen.findByText("Review your draft catalog");
    const publishBtn = () => screen.getByRole("button", { name: "Publish shop" }) as HTMLButtonElement;
    expect(publishBtn().disabled).toBe(true);
    const fixButtons = screen.getAllByRole("button", { name: /^fix r\d+$/ });
    fireEvent.click(fixButtons[1]); // the Bowl row, price 0 -> 12.34
    await waitFor(() => expect(publishBtn().disabled).toBe(false));
    fireEvent.click(publishBtn());
    expect((await screen.findByTestId("mcp-url")).textContent).toBe("http://localhost:3000/m/clay-shop/mcp");
    expect(screen.getByRole("button", { name: "Copy URL" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try it in the agent playground" }).getAttribute("href")).toBe("/playground?shop=clay-shop");
    expect(screen.getByRole("link", { name: "Open dashboard" }).getAttribute("href")).toBe("/?shop=clay-shop");
  });

  it("review: deleting every row shows the empty state; the shop name is required to publish", async () => {
    mockFetch(() => ndjson([{ type: "result", result: result({ products: [{ sku: "A", title: "Mug", description: "", price_cents: 100, currency: "USD", stock: 1 }], warnings: [] }) }]));
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    await screen.findByText("Review your draft catalog");
    const publishBtn = () => screen.getByRole("button", { name: "Publish shop" }) as HTMLButtonElement;
    expect(publishBtn().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Shop name"), { target: { value: "  " } });
    expect(publishBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^delete r\d+$/ }));
    expect(await screen.findByText("No products in the draft")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a product" })).toBeTruthy();
  });

  it("shows the empty state when nothing was found on the site", async () => {
    mockFetch(() => ndjson([{ type: "result", result: result({ products: [], warnings: ["No products were found on that site."] }) }]));
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    expect(await screen.findByText("No products in the draft")).toBeTruthy();
    expect(screen.getByText(/No products were found on that site/)).toBeTruthy();
  });

  it("shows a server-reported error (for example an SSRF block) and lets the user retry", async () => {
    mockFetch(() => ndjson([step("validate", "running"), { type: "error", message: "Local and internal hosts are not allowed." }]));
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl("http://localhost/");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Local and internal hosts are not allowed/);
    expect((screen.getByRole("button", { name: "Build my catalog" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the rate-limit message from a 429", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "rate_limited", message: "Too many requests. Try again in 42s." }), { status: 429 }));
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Try again in 42s/);
  });

  it("reports a dropped connection and a network failure", async () => {
    mockFetch(() => ndjson([step("fetch", "running")]));
    const { unmount } = render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    expect((await screen.findByRole("alert")).textContent).toMatch(/connection ended/);
    unmount();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Failed to fetch"))));
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Failed to fetch/);
  });

  it("surfaces a publish failure as a toast-level error without leaving the review screen", async () => {
    mockFetch((url) =>
      url === "/api/ingest"
        ? ndjson([{ type: "result", result: result({ products: [{ sku: "A", title: "Mug", description: "", price_cents: 100, currency: "USD", stock: 1 }], warnings: [] }) }])
        : new Response(JSON.stringify({ error: "too_many_shops", message: "A workspace can hold 5 shops." }), { status: 409 }),
    );
    render(<SetupClient shopCount={0} maxShops={5} />);
    await startUrl();
    await screen.findByText("Review your draft catalog");
    fireEvent.click(screen.getByRole("button", { name: "Publish shop" }));
    await waitFor(() => expect(calls().some(([u]) => u === "/api/shops")).toBe(true));
    expect(screen.getByText("Review your draft catalog")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Publish shop" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("CSV upload posts the file text to the ingest endpoint", async () => {
    mockFetch(() => ndjson([{ type: "result", result: result({ shopName: "My CSV shop", sourceUrl: "" }) }]));
    render(<SetupClient shopCount={0} maxShops={5} />);
    fireEvent.click(screen.getByRole("button", { name: "From a CSV" }));
    const file = new File(["title,price\nMug,5\n"], "p.csv", { type: "text/csv" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText("Review your draft catalog");
    expect(JSON.parse(calls()[0][1].body as string)).toEqual({ csv: "title,price\nMug,5\n" });
    expect((screen.getByLabelText("Shop name") as HTMLInputElement).value).toBe("My CSV shop");
  });

  it("refuses a CSV over 1 MB without sending it", async () => {
    mockFetch(() => ndjson([]));
    render(<SetupClient shopCount={0} maxShops={5} />);
    fireEvent.click(screen.getByRole("button", { name: "From a CSV" }));
    const big = new File([new Uint8Array(1_000_001)], "big.csv", { type: "text/csv" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [big] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/larger than 1 MB/);
    expect(calls()).toHaveLength(0);
  });
});
