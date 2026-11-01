import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureCheckout, createCheckout } from "@/lib/orders";
import { issueQuote } from "@/lib/quote";
import { installTestDb } from "./helpers";

const nav = vi.hoisted(() => ({ path: "/receipt/x" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => nav.path }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

import ReceiptPage from "@/app/receipt/[orderId]/page";
import OrderDetailPage from "@/app/orders/[id]/page";
import { AppShell } from "@/components/shell/AppShell";
import { isPublicPath } from "@/components/shell/nav";

const html = renderToStaticMarkup;
const page = (orderId: string, paypal?: string) => ReceiptPage({ params: Promise.resolve({ orderId }), searchParams: Promise.resolve(paypal ? { paypal } : {}) });

beforeEach(() => {
  vi.stubEnv("QUOTE_SIGNING_SECRET", "receipt-secret");
  vi.stubEnv("PAYPAL_CLIENT_ID", "");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
});

async function order(offerCents?: number) {
  const { db, shop } = installTestDb();
  const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 2, offerCents, agentId: "receipt-test" });
  const c = await createCheckout(db, shop, q.id, "http://localhost:3000");
  return { db, id: c.order_id };
}

/** Things only the merchant may see. */
const MERCHANT_WORDS = [/floor/i, /margin/i, /\bcost\b/i, /cost_cents/i, /Audit/i, /webhook/i, /signature/i, /rules/i];
const MERCHANT_LINKS = /href="\/(orders|disputes|settings|catalog|setup|chat|quote|checkout)/;
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ");
function expectNoMerchantData(markup: string) {
  for (const bad of MERCHANT_WORDS) expect(textOf(markup), String(bad)).not.toMatch(bad);
  expect(markup).not.toMatch(MERCHANT_LINKS);
}

describe("public buyer receipt", () => {
  it("shows a paid order with shop, item, quantity, unit price, total, order id and the get_order_status note", async () => {
    const { db, id } = await order(4700);
    await captureCheckout(db, id);
    const out = html(await page(id));
    expect(out).toContain("Payment received");
    expect(out).toContain("Paid");
    expect(out).toContain("Loom &amp; Thread");
    expect(out).toContain("Merino wool scarf, grey");
    expect(out).toMatch(/Quantity<\/span><b>2</);
    expect(out).toContain("47.00 USD"); // unit price
    expect(out).toContain("94.00 USD"); // total
    expect(out).toContain(id);
    expect(out).toContain("get_order_status");
    expect(out).toContain("simulated payment");
    expect(out).not.toContain("ReceiptSync"); // nothing left to wait for
    expectNoMerchantData(out);
    expect(db.prepare("SELECT 1").get()).toBeTruthy();
  });

  it("shows pending states with a live-update note, and 'cancelled' after backing out at PayPal", async () => {
    const { id } = await order();
    const pending = html(await page(id));
    expect(pending).toContain("Payment pending");
    expect(pending).toContain("Waiting for PayPal to confirm");
    expectNoMerchantData(pending);
    const returned = html(await page(id, "return"));
    expect(returned).toContain("Payment pending");
    const cancelled = html(await page(id, "cancel"));
    expect(cancelled).toContain("Payment cancelled");
    expect(cancelled).not.toContain("Waiting for PayPal");
  });

  it("shows the processing state once PayPal approved", async () => {
    const { db, id } = await order();
    db.prepare("UPDATE orders SET status = 'APPROVED' WHERE id = ?").run(id);
    const out = html(await page(id));
    expect(out).toContain("Payment processing");
    expect(out).toContain("Processing");
  });

  it("shows failed and refunded orders plainly", async () => {
    const { db, id } = await order();
    db.prepare("UPDATE orders SET status = 'FAILED' WHERE id = ?").run(id);
    const failed = html(await page(id));
    expect(failed).toContain("Payment failed");
    expect(failed).toContain('role="alert"');
    db.prepare("UPDATE orders SET status = 'REFUNDED' WHERE id = ?").run(id);
    expect(html(await page(id))).toContain("Payment refunded");
  });

  it("shows a friendly not-found state for an unknown order", async () => {
    installTestDb();
    const out = html(await page("ord_nope"));
    expect(out).toContain("We could not find this order");
    expect(out).toContain('data-testid="receipt-not-found"');
    expect(out).toContain("get_order_status");
  });

  it("does not leak negotiation internals even for a negotiated order", async () => {
    const { db, id } = await order(100);
    await captureCheckout(db, id);
    const out = html(await page(id));
    expect(out).not.toMatch(/reasons|ask_cents|offer_cents|negotiat/i);
    expect(out).toContain("46.64 USD"); // only the agreed unit price
  });
});

describe("layout: receipt is public, merchant pages keep the shell", () => {
  it("isPublicPath matches only /receipt", () => {
    expect(isPublicPath("/receipt/ord_1")).toBe(true);
    expect(isPublicPath("/receipt")).toBe(true);
    expect(isPublicPath("/receipts")).toBe(false);
    expect(isPublicPath("/orders/ord_1")).toBe(false);
    expect(isPublicPath(null)).toBe(false);
  });

  it("on /receipt the shell renders no sidebar, nav, mode badges or reset note", () => {
    nav.path = "/receipt/ord_1";
    const out = html(<AppShell badges={<span>MODE-BADGES</span>}>content</AppShell>);
    expect(out).toContain("content");
    expect(out).toContain("public-shell");
    expect(out).not.toContain('id="sidebar"');
    expect(out).not.toContain("Orders &amp; disputes");
    expect(out).not.toContain('href="/setup"');
    expect(out).not.toContain("MODE-BADGES");
    expect(out).not.toContain("resets when the server restarts");
  });

  it("on other pages the merchant shell is unchanged", () => {
    nav.path = "/orders";
    const out = html(<AppShell badges={<span>MODE-BADGES</span>}>content</AppShell>);
    expect(out).toContain('id="sidebar"');
    expect(out).toContain("MODE-BADGES");
    expect(out).not.toContain("public-shell");
  });

  it("the merchant order detail keeps the audit trail and links to the buyer receipt", async () => {
    const { id } = await order();
    const out = html(await OrderDetailPage({ params: Promise.resolve({ id }) }));
    expect(out).toContain("Audit trail");
    expect(out).toContain(`href="/receipt/${id}"`);
  });
});
