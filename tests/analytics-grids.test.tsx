// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGrid, DisputeGrid, SalesGrid, Thumb, UnmetGrid } from "@/components/analytics/AnalyticsGrids";
import { MarketLine } from "@/components/market/MarketLine";
import { computeMarket } from "@/lib/market";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("analytics grids (real AG Grid)", () => {
  it("mount with rows and with none, with no console errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <div>
        <SalesGrid rows={[{ day: "2026-11-01", orders: 2, paid: 2, revenue_cents: 9000, demo: 2 }]} />
        <AgentGrid rows={[{ agent: "claude-desktop", searches: 5, zero_results: 1, last_seen: "2026-11-01 10:00:00", demo: 5 }]} />
        <DisputeGrid rows={[{ id: "d1", order_id: "o1", reason: "UNAUTHORISED", status: "OPEN", amount_cents: 1000, currency: "USD", created_at: "2026-11-01 10:00:00", demo: 1 }]} />
        <UnmetGrid
          rows={[{ id: "ceramic mug", query: "ceramic mug", searches: 3, agents: 2, zero: 3, weak: 0, last_seen: "x", demo: 3, source: "snapshot", suggestions: [{ title: "Mug", price: 12, currency: "USD", retailer: "r.example", image: null }] }]}
        />
        <SalesGrid rows={[]} />
      </div>,
    );
    await waitFor(() => expect(container.querySelectorAll(".ag-root-wrapper").length).toBe(5));
    await waitFor(() => expect(container.textContent).toContain("Mug"));
    expect(container.textContent).toContain("Demo");
    expect(errors).not.toHaveBeenCalled();
  });

  it("Thumb falls back to a placeholder when the image fails or is missing", () => {
    const { container } = render(<Thumb src="https://img.example/x.png" alt="" />);
    const img = container.querySelector("img")!;
    img.dispatchEvent(new Event("error"));
    return waitFor(() => expect(container.querySelector("img")).toBeNull());
  });

  it("MarketLine renders limited and ok states, links never rendered", () => {
    const ok = computeMarket({ source: "snapshot", products: [{ title: "A", image: null, retailer: "r", price: 10, currency: "USD", in_stock: true, url: "https://buy.trychannel3.com/x" }, { title: "B", image: null, retailer: "r", price: 20, currency: "USD", in_stock: true, url: "https://buy.trychannel3.com/y" }] }, "USD");
    const a = render(<MarketLine m={ok} samples />);
    expect(a.container.textContent).toContain("snapshot");
    expect(a.container.innerHTML).not.toContain("trychannel3");
    cleanup();
    const b = render(<MarketLine m={computeMarket({ source: "none", products: [] }, "USD")} />);
    expect(b.container.textContent).toContain("limited market data");
  });
});
