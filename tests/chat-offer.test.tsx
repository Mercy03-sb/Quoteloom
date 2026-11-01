// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatClient } from "@/components/chat/ChatClient";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const quoteResult = (over: Record<string, unknown> = {}) => ({
  quote_id: "q-1", sku: "LT-SCARF-WOOL-GRY", title: "Merino wool scarf", qty: 1, unit_price: "48.00", total: "48.00", currency: "USD",
  expires_at: "2099-01-01T00:00:00Z", signature: "abcdef0123456789abcdef0123456789", list_price: "48.00",
  quantity_discounts: [{ min_qty: 5, discount_pct: 5 }, { min_qty: 10, discount_pct: 10 }],
  negotiation: { outcome: "list_price", list_price: "48.00", offered: null, final_unit_price: "48.00", reasons: [] },
  ...over,
});
const quoteMsg = (id: number, result: Record<string, unknown>) => ({ id, from: "tool", outcome: { tool: "request_quote", args: {}, isError: false, result } });
const reply = (result: Record<string, unknown>, isError = false) => new Response(JSON.stringify({ tool: "request_quote", args: {}, isError, result }), { status: 200 });

let chatBodies: Record<string, unknown>[];
function setup(chat: (body: Record<string, unknown>) => Promise<Response>) {
  chatBodies = [];
  const stored = [quoteMsg(1, quoteResult())];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/conversation")) {
        return json(init?.method === "PUT" ? { missing: { quotes: [], orders: [] } } : { messages: stored, missing: { quotes: [], orders: [] } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      chatBodies.push(body);
      return chat(body);
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = (() => {}) as Element["scrollIntoView"];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const offerInput = () => screen.getByLabelText(/Your offer per unit/) as HTMLInputElement;
const qtyInput = () => screen.getByLabelText("Quantity") as HTMLInputElement;

describe("Make an offer on a quote card", () => {
  it("shows the quantity discounts and updates them when the quantity changes", async () => {
    setup(() => json({}));
    render(<ChatClient shopSlug="s" />);
    await screen.findByText("Merino wool scarf");
    const list = screen.getByRole("list", { name: "Quantity discounts" });
    expect(list.textContent).toContain("5+ units: 5% off");
    expect(list.textContent).toContain("45.60 USD each");
    expect(screen.getByText(/No discount at 1\. Add 4 more for 5% off/)).toBeTruthy();
    fireEvent.change(qtyInput(), { target: { value: "5" } });
    expect(screen.getByText(/At 5 you get 5% off\. Add 5 more for 10% off/)).toBeTruthy();
    expect(within(list).getAllByRole("listitem")[0].getAttribute("data-active")).toBe("true");
    fireEvent.change(qtyInput(), { target: { value: "12" } });
    expect(screen.getByText(/At 12 you get 10% off\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-quote at 12" })).toBeTruthy();
  });

  it("validates the offer before calling the shop", async () => {
    setup(() => json({}));
    render(<ChatClient shopSlug="s" />);
    await screen.findByText("Merino wool scarf");
    fireEvent.click(screen.getByRole("button", { name: "Make an offer" }));
    expect(screen.getByRole("alert").textContent).toMatch(/unit price you want to pay/);
    fireEvent.change(offerInput(), { target: { value: "40.555" } });
    fireEvent.click(screen.getByRole("button", { name: "Make an offer" }));
    expect(screen.getByRole("alert").textContent).toMatch(/two decimals/);
    expect(chatBodies).toHaveLength(0);
  });

  it("sends offer_price, shows loading, then the counter with reasons and the new signed quote", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setup(async () => {
      await gate;
      return reply(
        quoteResult({
          quote_id: "q-2", unit_price: "40.80", total: "40.80", signature: "zzzzzz0123456789abcdef0123456789",
          negotiation: { outcome: "countered", list_price: "48.00", offered: "30.00", final_unit_price: "40.80", reasons: ["Your offer of 30.00 is lower than the shop can accept. The best price it can do is 40.80 per unit."] },
          message: "We can do 40.80 per unit.",
        }),
      );
    });
    render(<ChatClient shopSlug="s" />);
    await screen.findByText("Merino wool scarf");
    fireEvent.change(offerInput(), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Make an offer" }));
    await screen.findByText("Asking the shop…");
    expect(offerInput().disabled).toBe(true);
    release();
    await screen.findByTestId("negotiation-result");
    expect(chatBodies[0]).toMatchObject({ action: "quote", sku: "LT-SCARF-WOOL-GRY", qty: 1, offer_price: 30, shop: "s" });
    const res = screen.getByTestId("negotiation-result");
    expect(res.textContent).toContain("Counter-offer");
    expect(res.textContent).toContain("You offered 30.00 USD, list price 48.00 USD");
    expect(within(res).getByRole("list", { name: "Decision reasons" }).textContent).toContain("best price it can do is 40.80");
    expect(res.textContent).toContain("We can do 40.80 per unit.");
    expect(screen.getByText(/The shop answered with its best price/)).toBeTruthy();
    // the new quote is the only card with the offer form; the old card keeps its details
    expect(screen.getAllByRole("form", { name: "Quantity and offer" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Inspect quote" })).toHaveLength(2);
  });

  it("says so when the shop accepts the offer", async () => {
    setup(async () =>
      reply(quoteResult({ quote_id: "q-3", unit_price: "44.00", negotiation: { outcome: "accepted", list_price: "48.00", offered: "44.00", final_unit_price: "44.00", reasons: ["Your offer of 44.00 is within what the shop can accept."] } })),
    );
    render(<ChatClient shopSlug="s" />);
    await screen.findByText("Merino wool scarf");
    fireEvent.change(offerInput(), { target: { value: "44" } });
    fireEvent.click(screen.getByRole("button", { name: "Make an offer" }));
    await screen.findByText(/The shop accepted your offer/);
    expect(screen.getByTestId("negotiation-result").textContent).toContain("Offer accepted");
  });

  it("shows a shop error as a chat message and re-enables the form", async () => {
    setup(async () => reply({ error: "quantity_too_large", message: "This shop sells at most 20 per order." }, true));
    render(<ChatClient shopSlug="s" />);
    await screen.findByText("Merino wool scarf");
    fireEvent.change(qtyInput(), { target: { value: "50" } });
    fireEvent.change(offerInput(), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Make an offer" }));
    await screen.findByText("This shop sells at most 20 per order.");
    await waitFor(() => expect(offerInput().disabled).toBe(false));
  });

  it("handles a rate-limit failure without losing the card", async () => {
    setup(async () => new Response(JSON.stringify({ message: "Too many requests. Try again in 5s." }), { status: 429 }));
    render(<ChatClient shopSlug="s" />);
    await screen.findByText("Merino wool scarf");
    fireEvent.change(offerInput(), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Make an offer" }));
    await screen.findByText(/Something went wrong reaching the shop/);
    expect(screen.getByText("Merino wool scarf")).toBeTruthy();
    await waitFor(() => expect(offerInput().disabled).toBe(false));
  });

  it("re-quotes at a new quantity without an offer", async () => {
    setup(async () => reply(quoteResult({ quote_id: "q-4", qty: 5, unit_price: "45.60", total: "228.00" })));
    render(<ChatClient shopSlug="s" />);
    await screen.findByText("Merino wool scarf");
    fireEvent.change(qtyInput(), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Re-quote at 5" }));
    await waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]).toMatchObject({ qty: 5 });
    expect(chatBodies[0]).not.toHaveProperty("offer_price");
  });
});
