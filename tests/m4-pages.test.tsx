import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateDispute } from "@/lib/disputes";
import { captureCheckout, createCheckout } from "@/lib/orders";
import { issueQuote } from "@/lib/quote";
import { createShop } from "@/lib/shops";
import { resolveWorkspace } from "@/lib/workspace";
import { getDb } from "@/lib/db";
import { installTestDb, jsonReq } from "./helpers";

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "ql_ws" && state.cookie ? { value: state.cookie } : undefined) }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/orders" }));

import OrdersPage from "@/app/orders/page";
import OrderDetailPage from "@/app/orders/[id]/page";
import DisputesPage from "@/app/disputes/page";
import DisputeDetailPage from "@/app/disputes/[id]/page";
import SettingsPage from "@/app/settings/page";
import { PUT as putRules } from "@/app/api/shops/[slug]/rules/route";
import { POST as simulate } from "@/app/api/disputes/simulate/route";
import { POST as submit } from "@/app/api/disputes/[id]/submit/route";
import { AppShell } from "@/components/shell/AppShell";

const html = renderToStaticMarkup;
const sp = (shop?: string) => ({ searchParams: Promise.resolve(shop ? { shop } : {}) });
const idp = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.stubEnv("QUOTE_SIGNING_SECRET", "m4-secret");
  vi.stubEnv("PAYPAL_CLIENT_ID", "");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
  state.cookie = undefined;
});
afterEach(() => vi.unstubAllEnvs());

async function seedPaid(offerCents?: number) {
  const { db, shop } = installTestDb();
  const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1, offerCents, agentId: "page-test" });
  const c = await createCheckout(db, shop, q.id, "http://localhost:3000");
  await captureCheckout(db, c.order_id);
  return { db, shop, orderId: c.order_id, quoteId: q.id };
}

describe("orders pages render", () => {
  it("orders list: heading, tabs and the grid loader; empty database is fine", async () => {
    installTestDb();
    const out = html(await OrdersPage());
    expect(out).toContain("Orders &amp; disputes");
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('href="/disputes"');
    await seedPaid();
    expect(html(await OrdersPage())).toContain("Orders &amp; disputes");
  });

  it("order detail shows price, negotiation outcome, audit trail and the simulate button", async () => {
    const { orderId } = await seedPaid(4300);
    const out = html(await OrderDetailPage(idp(orderId)));
    expect(out).toContain(orderId);
    expect(out).toContain("PAID");
    expect(out).toContain("Negotiation");
    expect(out).toContain("43.00");
    expect(out).toContain("accepted");
    expect(out).toContain("Audit trail");
    expect(out).toContain("Simulate dispute");
    expect(out).toContain("Nothing is sent to PayPal");
  });

  it("order detail: unpaid orders cannot be disputed; unknown and foreign orders show not found", async () => {
    const { db, shop } = installTestDb();
    const q = issueQuote(db, shop, { sku: "LT-SCARF-WOOL-GRY", qty: 1 });
    const c = await createCheckout(db, shop, q.id, "http://localhost:3000");
    const out = html(await OrderDetailPage(idp(c.order_id)));
    expect(out).not.toContain("Simulate dispute</button>");
    expect(out).toContain("once the order is paid");
    expect(html(await OrderDetailPage(idp("nope")))).toContain("Order not found");

    // an order in another workspace's shop is invisible
    const ws = resolveWorkspace(db, new Headers()).id;
    const { shop: mine } = createShop(db, ws, { name: "Private", source_url: null, products: [{ sku: "P", title: "Pot", description: "", price_cents: 1000, currency: "USD", stock: 3 }] });
    const q2 = issueQuote(db, mine, { sku: "P", qty: 1 });
    const c2 = await createCheckout(db, mine, q2.id, "http://localhost:3000");
    expect(html(await OrderDetailPage(idp(c2.order_id)))).toContain("Order not found"); // no cookie
    state.cookie = ws;
    expect(html(await OrderDetailPage(idp(c2.order_id)))).toContain(c2.order_id);
  });
});

describe("disputes pages render", () => {
  it("disputes list renders with and without disputes", async () => {
    const { db, orderId } = await seedPaid();
    expect(html(await DisputesPage())).toContain("evidence packet");
    simulateDispute(db, orderId);
    expect(html(await DisputesPage())).toContain("Orders &amp; disputes");
  });

  it("dispute detail shows the labelled simulation, every packet section and the approve button", async () => {
    const { db, orderId, quoteId } = await seedPaid(4300);
    const d = simulateDispute(db, orderId);
    const out = html(await DisputeDetailPage(idp(d.id)));
    for (const s of ["Simulated", "Checks", "Buyer request", "Negotiation transcript", "Signed quote", "Order and capture", "Timeline", "Approval"]) expect(out).toContain(s);
    expect(out).toContain("Needs evidence");
    expect(out).toContain("Approve and submit (simulated)");
    expect(out).toContain(quoteId);
    expect(out).toContain("page-test");
    expect(out).toContain("SIMCAP-");
    expect(out).toContain("Signature");
    expect(out).toContain("intact");
  });

  it("after submission the page says evidence was sent, simulated, and the button is gone", async () => {
    const { orderId } = await seedPaid();
    const d = simulateDispute(getDb(), orderId);
    const res = await submit(jsonReq("http://localhost:3000/api/disputes/x/submit", {}), idp(d.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "SUBMITTED", simulated: true });
    const out = html(await DisputeDetailPage(idp(d.id)));
    expect(out).toContain("Evidence submitted");
    expect(out).toContain("nothing was sent to PayPal");
    expect(out).not.toContain("Approve and submit");
  });

  it("unknown dispute shows not found", async () => {
    installTestDb();
    expect(html(await DisputeDetailPage(idp("nope")))).toContain("Dispute not found");
  });
});

describe("settings page and rules API", () => {
  const rules = { negotiation: true, max_discount_pct: 25, min_margin_pct: 10, max_qty: 9, quantity_breaks: [{ min_qty: 4, discount_pct: 8 }] };

  it("demo shop: read-only notice and a disabled form", async () => {
    installTestDb();
    const out = html(await SettingsPage(sp()));
    expect(out).toContain("Shop settings");
    expect(out).toContain("read-only");
    expect(out).toContain("Negotiation rules");
    expect(out).toContain("Quantity breaks");
    expect(out).toContain("disabled");
  });

  it("own shop: editable form, and saving through the API changes the rules", async () => {
    const { db } = installTestDb();
    const ws = resolveWorkspace(db, new Headers()).id;
    const { shop } = createShop(db, ws, { name: "Rules Shop", source_url: null, products: [{ sku: "P", title: "Pot", description: "", price_cents: 1000, currency: "USD", stock: 3 }] });
    state.cookie = ws;
    const out = html(await SettingsPage(sp()));
    expect(out).toContain("Rules Shop");
    expect(out).not.toContain("read-only");
    const cookie = `ql_ws=${ws}`;
    const ok = await putRules(jsonReq("http://localhost:3000/x", rules, { cookie }, "PUT"), { params: Promise.resolve({ slug: shop.slug }) });
    expect(ok.status).toBe(200);
    const bad = await putRules(jsonReq("http://localhost:3000/x", { ...rules, max_discount_pct: 500 }, { cookie }, "PUT"), { params: Promise.resolve({ slug: shop.slug }) });
    expect(bad.status).toBe(400);
    const demo = await putRules(jsonReq("http://localhost:3000/x", rules, { cookie }, "PUT"), { params: Promise.resolve({ slug: "loom-and-thread" }) });
    expect(demo.status).toBe(403);
    const stranger = await putRules(jsonReq("http://localhost:3000/x", rules, {}, "PUT"), { params: Promise.resolve({ slug: shop.slug }) });
    expect(stranger.status).toBe(404);
    expect(html(await SettingsPage(sp()))).toContain('value="25"');
  });

  it("empty database shows the empty state", async () => {
    const { db } = installTestDb();
    db.exec("DELETE FROM shops");
    expect(html(await SettingsPage(sp()))).toContain("No shop yet");
  });
});

describe("dispute API guards", () => {
  it("simulate: validates input, needs a paid order, and sees only visible orders", async () => {
    const { orderId } = await seedPaid();
    const url = "http://localhost:3000/api/disputes/simulate";
    expect((await simulate(jsonReq(url, {}))).status).toBe(400);
    expect((await simulate(jsonReq(url, { order_id: "nope" }))).status).toBe(404);
    const ok = await simulate(jsonReq(url, { order_id: orderId }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ simulated: true });
    expect((await submit(jsonReq("http://localhost:3000/x", {}), idp("nope"))).status).toBe(404);
  });
});

describe("shell", () => {
  it("the nav shows Orders & disputes and Shop settings as real links, no Soon badge for them", () => {
    const out = html(<AppShell badges={null}>x</AppShell>);
    expect(out).toContain('href="/orders"');
    expect(out).toContain('href="/settings"');
    expect(out).toContain("Orders &amp; disputes");
    expect(out.match(/Soon/g)?.length).toBe(1); // only Analytics is left
  });
});
