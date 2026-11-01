// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatClient } from "@/components/chat/ChatClient";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const quoteMsg = (id: number, quoteId: string) => ({
  id,
  from: "tool",
  outcome: {
    tool: "request_quote",
    args: { sku: "LT-SCARF-WOOL-GRY", qty: 1 },
    isError: false,
    result: { quote_id: quoteId, title: "Merino wool scarf", qty: 1, unit_price: "48.00", total: "48.00", currency: "USD", expires_at: "2099-01-01T00:00:00Z", signature: "abcdef0123456789abcdef0123456789" },
  },
});
const orderMsg = (id: number, orderId: string) => ({
  id,
  from: "tool",
  outcome: { tool: "create_checkout", args: {}, isError: false, result: { order_id: orderId, status: "CREATED", total: "48.00", currency: "USD", mode: "simulation", approval_url: "/checkout/x" } },
});

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = (() => {}) as Element["scrollIntoView"];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatClient", () => {
  it("renders and its effects return only cleanup functions", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A scrollIntoView that returns a value must not leak out of useEffect.
    const scroll = vi.fn(() => Promise.resolve("not-a-cleanup"));
    Element.prototype.scrollIntoView = scroll as unknown as Element["scrollIntoView"];
    vi.stubGlobal("fetch", vi.fn(() => json({ messages: [], missing: { quotes: [], orders: [] } })));

    const { unmount } = render(<ChatClient shopSlug="loom-and-thread" />);
    expect(screen.getByRole("log")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Restoring your conversation/)).toBeNull());
    expect(scroll).toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("restores the server conversation after a reload and shows still-valid quotes normally", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ messages: [{ id: 0, from: "agent", text: "welcome back" }, { id: 1, from: "you", text: "show me a scarf please" }, quoteMsg(2, "q-ok")], missing: { quotes: [], orders: [] } })));
    render(<ChatClient shopSlug="loom-and-thread" />);
    await screen.findByText("welcome back");
    expect(screen.getByText("show me a scarf please")).toBeTruthy();
    expect(screen.getByText("Merino wool scarf")).toBeTruthy();
    expect(screen.queryByTestId("quote-unavailable")).toBeNull();
    expect(screen.getByRole("link", { name: "Inspect quote" })).toBeTruthy();
  });

  it("shows a clear 'no longer available' state for a quote and an order that were reset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ messages: [{ id: 0, from: "agent", text: "hi" }, quoteMsg(1, "q-gone"), orderMsg(2, "o-gone")], missing: { quotes: ["q-gone"], orders: ["o-gone"] } })),
    );
    render(<ChatClient shopSlug="loom-and-thread" />);
    expect(await screen.findByTestId("quote-unavailable")).toBeTruthy();
    expect(screen.getByTestId("order-unavailable").textContent).toMatch(/no longer available/);
    expect(screen.queryByRole("link", { name: "Inspect quote" })).toBeNull();
    expect(screen.queryByText("Check out with PayPal")).toBeNull();
    expect(screen.queryByText("Open checkout to pay")).toBeNull();
  });

  it("falls back to the localStorage mirror when the server has nothing, and pushes it back up", async () => {
    window.localStorage.setItem("ql-chat:loom-and-thread", JSON.stringify([{ id: 0, from: "agent", text: "hi" }, { id: 1, from: "you", text: "from the mirror" }]));
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "PUT" ? json({ saved: 2, missing: { quotes: [], orders: [] } }) : json({ messages: [], missing: { quotes: [], orders: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatClient shopSlug="loom-and-thread" />);
    await screen.findByText("from the mirror");
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBe(true));
  });

  it("still shows the mirrored conversation when the server is unreachable", async () => {
    window.localStorage.setItem("ql-chat:loom-and-thread", JSON.stringify([{ id: 0, from: "agent", text: "hi" }, { id: 1, from: "you", text: "offline copy" }]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    render(<ChatClient shopSlug="loom-and-thread" />);
    await screen.findByText("offline copy");
    await waitFor(() => expect(screen.queryByText(/Restoring your conversation/)).toBeNull());
  });

  it("keeps conversations for different shops apart", async () => {
    window.localStorage.setItem("ql-chat:other-shop", JSON.stringify([{ id: 0, from: "you", text: "other shop talk" }]));
    vi.stubGlobal("fetch", vi.fn(() => json({ messages: [], missing: { quotes: [], orders: [] } })));
    render(<ChatClient shopSlug="loom-and-thread" />);
    await waitFor(() => expect(screen.queryByText(/Restoring your conversation/)).toBeNull());
    expect(screen.queryByText("other shop talk")).toBeNull();
  });
});
