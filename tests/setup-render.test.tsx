// @vitest-environment happy-dom
// Renders the Setup screen with the REAL AG Grid and fails on any React warning or console error.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/ui";
import { SetupClient } from "@/components/setup/SetupClient";
import { gridHeight, GRID_MAX_HEIGHT, GRID_MIN_HEIGHT, HEADER_HEIGHT, ROW_HEIGHT, SCROLLBAR_ALLOWANCE } from "@/components/setup/ReviewGrid";
import { DEMO_STORES, renderDemoShopPage } from "@/lib/demo-shops";
import { shopNameFrom } from "@/lib/ingest/extract";
import type { IngestResult } from "@/lib/ingest/pipeline";

let errors: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  Element.prototype.scrollIntoView = (() => {}) as Element["scrollIntoView"];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const result: IngestResult = {
  shopName: "Clay & Kiln",
  sourceUrl: "http://localhost:3000/demo-shops/clay-and-kiln",
  products: Array.from({ length: 3 }, (_, i) => ({ sku: `P-${i}`, title: `Item ${i}`, description: "d", price_cents: i === 2 ? 0 : 1000, currency: "USD", stock: 4 })),
  methods: { jsonld: 3, opengraph: 0, llm: 0, rules: 0 },
  warnings: ["1 product has no price. Fix them in the table before publishing."],
};
const stream = (events: unknown[]) =>
  new Response(new ReadableStream<Uint8Array>({ start(c) { events.forEach((e) => c.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n"))); c.close(); } }));

describe("Setup screen render", () => {
  it("idle, running and review (real grid) log no React warnings or errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => stream([{ type: "step", id: "validate", label: "x", status: "done" }, { type: "result", result }])));
    render(<ToastProvider><SetupClient shopCount={0} maxShops={5} /></ToastProvider>);
    fireEvent.change(screen.getByLabelText("Shop URL"), { target: { value: "http://localhost:3000/demo-shops/clay-and-kiln" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my catalog" }));
    expect(await screen.findByText("Review your draft catalog")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".ag-root-wrapper")).toBeTruthy());
    expect((screen.getByLabelText("Shop name") as HTMLInputElement).value).toBe("Clay & Kiln");
    expect(screen.getByRole("status").textContent).toMatch(/1 row needs fixing/);
    // the grid box is sized from the rows, not a fixed tall box
    expect((document.querySelector(".grid-box-setup") as HTMLElement).style.height).toBe(`${gridHeight(3)}px`);
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
  });

  it("the other phases (CSV tab, error, empty) log nothing either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => stream([{ type: "error", message: "Local and internal hosts are not allowed." }])));
    const { unmount } = render(<ToastProvider><SetupClient shopCount={0} maxShops={5} /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "From a CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "From a URL" }));
    fireEvent.change(screen.getByLabelText("Shop URL"), { target: { value: "http://localhost/" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my catalog" }));
    await screen.findByText("Could not build the catalog");
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => stream([{ type: "result", result: { ...result, products: [], warnings: [] } }])));
    render(<ToastProvider><SetupClient shopCount={0} maxShops={5} /></ToastProvider>);
    fireEvent.change(screen.getByLabelText("Shop URL"), { target: { value: "https://x.example/" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my catalog" }));
    await screen.findByText("No products in the draft");
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
  });

  it("server-renders the idle form without warnings", () => {
    const out = renderToStaticMarkup(<ToastProvider><SetupClient shopCount={0} maxShops={5} /></ToastProvider>);
    expect(out).toContain("Only ingest sites you own or have permission to use");
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("grid sizing", () => {
  it("fits content between a minimum and a maximum", () => {
    expect(gridHeight(0)).toBe(GRID_MIN_HEIGHT);
    expect(gridHeight(1)).toBe(GRID_MIN_HEIGHT);
    expect(gridHeight(6)).toBe(HEADER_HEIGHT + 6 * ROW_HEIGHT + 2 + SCROLLBAR_ALLOWANCE);
    expect(gridHeight(5)).toBeGreaterThanOrEqual(HEADER_HEIGHT + 5 * ROW_HEIGHT + SCROLLBAR_ALLOWANCE); // five rows, no vertical scrollbar
    expect(gridHeight(6)).toBeLessThan(GRID_MAX_HEIGHT);
    expect(gridHeight(200)).toBe(GRID_MAX_HEIGHT);
    expect(gridHeight(8)).toBeGreaterThan(gridHeight(5));
  });
});

describe("suggested shop name", () => {
  it("drops the (fake demo store) suffix for every demo store, from the title and from og:site_name", () => {
    for (const s of DEMO_STORES) {
      const name = shopNameFrom(renderDemoShopPage(`/demo-shops/${s.slug}`) as string, "localhost");
      expect(name).toBe(s.name.replace(/ \(fake demo store\)$/, ""));
    }
  });
  it("leaves ordinary names and other brackets alone, and still splits on separators", () => {
    expect(shopNameFrom("<title>Acme Goods (Est. 1990)</title>", "h")).toBe("Acme Goods (Est. 1990)");
    expect(shopNameFrom("<title>Acme | Home</title>", "h")).toBe("Acme");
    expect(shopNameFrom("<title>Shop (demo)</title>", "h")).toBe("Shop");
    expect(shopNameFrom("<p>no title</p>", "shop.example")).toBe("shop.example");
  });
});
