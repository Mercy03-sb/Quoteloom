import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { createShop } from "@/lib/shops";
import { resolveWorkspace } from "@/lib/workspace";
import { installTestDb } from "./helpers";

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "ql_ws" && state.cookie ? { value: state.cookie } : undefined) }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }), usePathname: () => "/setup" }));

import Dashboard from "@/app/page";
import CatalogPage from "@/app/catalog/page";
import ChatPage from "@/app/chat/page";
import SetupPage from "@/app/setup/page";
import { GET as demoShops } from "@/app/demo-shops/[[...path]]/route";
import { AppShell } from "@/components/shell/AppShell";

const html = renderToStaticMarkup;
const sp = (shop?: string) => ({ searchParams: Promise.resolve(shop ? { shop } : {}) });
const draft = [{ sku: "A-1", title: "Page Test Mug", description: "", price_cents: 900, currency: "USD", stock: 4 }];

function withOwnShop(): string {
  const { db } = installTestDb();
  const ws = resolveWorkspace(db, new Headers()).id;
  createShop(db, ws, { name: "My Pages Shop", source_url: null, products: draft });
  state.cookie = ws;
  return ws;
}

beforeEach(() => {
  state.cookie = undefined;
  installTestDb();
});

describe("pages render", () => {
  it("dashboard shows the demo shop for a visitor with no workspace", async () => {
    const out = html(await Dashboard(sp()));
    expect(out).toContain("Loom &amp; Thread");
    expect(out).toContain("/m/loom-and-thread/mcp");
    expect(out).not.toContain("<select"); // nothing to switch between
  });

  it("dashboard, catalog and chat show the workspace shop, with a switcher to the demo", async () => {
    withOwnShop();
    for (const out of [html(await Dashboard(sp())), html(await CatalogPage(sp())), html(await ChatPage(sp()))]) {
      expect(out).toContain("My Pages Shop");
      expect(out).toContain("<select");
      expect(out).toContain("Loom &amp; Thread");
    }
    expect(html(await Dashboard(sp()))).toContain("/m/my-pages-shop/mcp");
  });

  it("?shop= picks another visible shop and ignores one the visitor cannot see", async () => {
    withOwnShop();
    expect(html(await Dashboard(sp("loom-and-thread")))).toContain("/m/loom-and-thread/mcp");
    state.cookie = undefined; // a different visitor
    const out = html(await Dashboard(sp("my-pages-shop")));
    expect(out).toContain("/m/loom-and-thread/mcp");
    expect(out).not.toContain("My Pages Shop");
  });

  it("chat page hands the shop slug to the client, so its conversation is per shop", async () => {
    withOwnShop();
    const out = html(await ChatPage(sp()));
    expect(out).toContain('aria-label="Conversation"');
    expect(out).toContain("Restoring your conversation"); // initial server render of the restore state
  });

  it("empty states when the database has no shops", async () => {
    const { db } = installTestDb();
    db.exec("DELETE FROM shops");
    for (const out of [html(await Dashboard(sp())), html(await CatalogPage(sp())), html(await ChatPage(sp()))]) {
      expect(out).toContain("No shop yet");
    }
  });

  it("setup page: ownership notice, reset note, source toggle and demo-store shortcuts", async () => {
    const out = html(await SetupPage());
    expect(out).toContain("Set up a shop");
    expect(out).toContain("Only ingest sites you own or have permission to use");
    expect(out).toContain("resets on server restart");
    expect(out).toContain("From a URL");
    expect(out).toContain("From a CSV");
    expect(out).toContain("Build my catalog");
    expect(out).toContain("Clay &amp; Kiln");
  });

  it("app shell shows the demo-reset note and the Setup link on every page", () => {
    const out = html(<AppShell badges={null}>content</AppShell>);
    expect(out).toContain("The demo workspace resets when the server restarts.");
    expect(out).toContain('href="/setup"');
  });
});

describe("static demo shops and sample CSV", () => {
  const get = (path: string[]) => demoShops(new Request("http://localhost:3000/demo-shops"), { params: Promise.resolve({ path }) });

  it("serves the index, each store and a product page as HTML with JSON-LD", async () => {
    const index = await get([]);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    expect(await index.text()).toContain("clay-and-kiln");
    const store = await (await get(["clay-and-kiln"])).text();
    expect(store).toContain("application/ld+json");
    expect(store).toContain("Stoneware mug");
    const item = await (await get(["clay-and-kiln", "speckled-mug"])).text();
    expect(item).toContain('"@type":"Product"');
    expect(item).toContain("product:price:amount");
  });

  it("answers 404 for unknown pages", async () => {
    expect((await get(["nope"])).status).toBe(404);
    expect((await get(["clay-and-kiln", "nope"])).status).toBe(404);
  });

  it("ships the sample CSV as a static file", () => {
    expect(existsSync("public/sample-products.csv")).toBe(true);
  });
});
