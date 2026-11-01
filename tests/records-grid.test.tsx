// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));

import { DisputesTable } from "@/components/orders/DisputesTable";
import { OrdersTable } from "@/components/orders/OrdersTable";
import { RulesEditor } from "@/components/settings/RulesEditor";
import { DEFAULT_RULES } from "@/lib/policy";
import type { OrderListItem } from "@/lib/orders-view";
import type { DisputeListItem } from "@/lib/disputes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const order = (id: string, status: string, negotiated: boolean): OrderListItem => ({
  id, shop_slug: "s", sku: "A", title: `Item ${id}`, qty: 1, status, amount_cents: 1000, currency: "USD",
  unit_price_cents: 1000, list_price_cents: negotiated ? 1200 : 1000, negotiated, disputes: 0, created_at: "2026-11-01 10:00:00", captured_at: null,
});

describe("orders and disputes grids (real AG Grid)", () => {
  it("OrdersTable mounts with its toolbar, filters by status and negotiated, and shows an empty state", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = [order("o1", "PAID", true), order("o2", "CREATED", false), order("o3", "PAID", false)];
    const { container } = render(<OrdersTable rows={rows} />);
    await waitFor(() => expect(container.querySelector(".ag-root-wrapper")).toBeTruthy());
    expect(screen.getByText("3 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Paid" }));
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Negotiated only"));
    expect(screen.getByText("1 of 3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search orders"), { target: { value: "zzz" } });
    expect(screen.getByText("0 of 3")).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });

  it("OrdersTable with no orders shows the empty state, not a grid", () => {
    render(<OrdersTable rows={[]} />);
    expect(screen.getByText("No orders yet")).toBeTruthy();
  });

  it("DisputesTable mounts and shows its empty state when there are none", async () => {
    const d: DisputeListItem = {
      id: "dsp_1", order_id: "o1", paypal_dispute_id: "SIM-DSP-1", status: "OPEN", reason: "UNAUTHORISED", amount_cents: 1000, currency: "USD",
      simulated: 1, paypal_status: null, created_at: "2026-11-01 10:00:00", submitted_at: null, submission_json: null, evidence_json: "{}", shop_slug: "s", title: "Item",
    };
    const { container, rerender } = render(<DisputesTable rows={[d]} />);
    await waitFor(() => expect(container.querySelector(".ag-root-wrapper")).toBeTruthy());
    rerender(<DisputesTable rows={[]} />);
    expect(screen.getByText("No disputes")).toBeTruthy();
  });
});

describe("RulesEditor", () => {
  it("saves the edited rules with a PUT and reports success", async () => {
    const fetchMock = vi.fn(async () => Response.json({ rules: {} }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RulesEditor slug="my-shop" initial={{ ...DEFAULT_RULES, quantity_breaks: [{ min_qty: 5, discount_pct: 5 }] }} readOnly={false} />);
    fireEvent.change(screen.getByLabelText(/Max discount/), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a break" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Rules saved/));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/shops/my-shop/rules");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ max_discount_pct: 30, negotiation: true });
    expect(body.quantity_breaks).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("shows the server's message when saving fails, and is fully disabled when read-only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Max discount must be between 0 and 90 percent." }, { status: 400 })));
    const { unmount } = render(<RulesEditor slug="s" initial={DEFAULT_RULES} readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/between 0 and 90/));
    unmount();
    render(<RulesEditor slug="s" initial={DEFAULT_RULES} readOnly />);
    expect((screen.getByRole("button", { name: "Save rules" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Max discount/) as HTMLInputElement).disabled).toBe(true);
    vi.unstubAllGlobals();
  });
});
