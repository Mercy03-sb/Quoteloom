import { beforeEach, describe, expect, it } from "vitest";
import { POST as chat } from "@/app/api/chat/route";
import { GET as getConversation, PUT as putConversation } from "@/app/api/conversation/route";
import { POST as ingest } from "@/app/api/ingest/route";
import { POST as publish } from "@/app/api/shops/route";
import { seed } from "@/lib/seed";
import { createShop, MAX_SHOPS_PER_WORKSPACE, ShopError, slugify } from "@/lib/shops";
import { loadActiveShop } from "@/lib/shop-view";
import { findVisibleShop, isWorkspaceId, newWorkspaceId, readCookie, resolveWorkspace, visibleShops, workspaceCookie, workspaceIdFrom } from "@/lib/workspace";
import { cookieFrom, installTestDb, jsonReq } from "./helpers";

const product = (n: number) => ({ sku: `S-${n}`, title: `Thing ${n}`, description: "", price_cents: 500 + n, currency: "USD", stock: 3 });
const draft = (n = 2) => Array.from({ length: n }, (_, i) => product(i + 1));
const U = "http://localhost:3000";

describe("workspace cookie", () => {
  it("issues a random id as an httpOnly, SameSite cookie, once", () => {
    const { db } = installTestDb();
    const first = resolveWorkspace(db, new Headers(), true);
    expect(isWorkspaceId(first.id)).toBe(true);
    expect(first.setCookie).toMatch(/HttpOnly/);
    expect(first.setCookie).toMatch(/SameSite=Lax/);
    expect(first.setCookie).toMatch(/Secure/);
    const again = resolveWorkspace(db, new Headers({ cookie: `other=1; ${first.setCookie?.split(";")[0]}` }));
    expect(again.id).toBe(first.id);
    expect(again.setCookie).toBeNull();
  });

  it("ids are unguessable and unique, and malformed cookies are ignored", () => {
    expect(newWorkspaceId()).not.toBe(newWorkspaceId());
    expect(newWorkspaceId()).toMatch(/^ws_[a-f0-9]{32}$/);
    expect(workspaceIdFrom(new Headers({ cookie: "ql_ws=admin" }))).toBeNull();
    expect(workspaceIdFrom(new Headers({ cookie: "ql_ws=ws_1 OR 1=1" }))).toBeNull();
    expect(readCookie("a=1; b=2", "b")).toBe("2");
    expect(workspaceCookie("ws_x", false)).not.toMatch(/Secure/);
  });
});

describe("workspace isolation", () => {
  beforeEach(() => {
    installTestDb();
  });

  it("each workspace sees the demo shop plus only its own shops", () => {
    const { db } = installTestDb();
    const a = resolveWorkspace(db, new Headers()).id;
    const b = resolveWorkspace(db, new Headers()).id;
    createShop(db, a, { name: "Alpha Store", source_url: null, products: draft() });
    createShop(db, b, { name: "Beta Store", source_url: null, products: draft() });
    expect(visibleShops(db, a).map((s) => s.slug)).toEqual(["alpha-store", "loom-and-thread"]);
    expect(visibleShops(db, b).map((s) => s.slug)).toEqual(["beta-store", "loom-and-thread"]);
    expect(visibleShops(db, null).map((s) => s.slug)).toEqual(["loom-and-thread"]);
    expect(findVisibleShop(db, a, "beta-store")).toBeUndefined();
    expect(findVisibleShop(db, b, "loom-and-thread")).toBeDefined();
  });

  it("pages cannot be pointed at another workspace shop with ?shop=", () => {
    const { db } = installTestDb();
    const a = resolveWorkspace(db, new Headers()).id;
    const b = resolveWorkspace(db, new Headers()).id;
    createShop(db, a, { name: "Alpha Store", source_url: null, products: draft() });
    expect(loadActiveShop(a, "alpha-store")?.shop.slug).toBe("alpha-store");
    expect(loadActiveShop(b, "alpha-store")?.shop.slug).toBe("loom-and-thread");
    expect(loadActiveShop(null, "alpha-store")?.shop.slug).toBe("loom-and-thread");
    expect(loadActiveShop(a)?.shop.slug).toBe("alpha-store"); // newest own shop is the default
  });

  it("buyer chat refuses another workspace shop, and allows the demo shop and its own", async () => {
    const { db } = installTestDb();
    const a = await publish(jsonReq(`${U}/api/shops`, { name: "Alpha Store", products: draft() }));
    const cookieA = cookieFrom(a);
    const cookieB = cookieFrom(await chat(jsonReq(`${U}/api/chat`, { action: "search", shop: "loom-and-thread", query: "scarf" })));
    expect(cookieB).not.toBe(cookieA);
    const mine = await chat(jsonReq(`${U}/api/chat`, { action: "search", shop: "alpha-store", query: "thing" }, { cookie: cookieA }));
    expect(mine.status).toBe(200);
    const theirs = await chat(jsonReq(`${U}/api/chat`, { action: "search", shop: "alpha-store", query: "thing" }, { cookie: cookieB }));
    expect(theirs.status).toBe(404);
    const logged = db.prepare("SELECT COUNT(*) AS n FROM search_log s JOIN shops p ON p.id = s.shop_id WHERE p.slug = 'alpha-store'").get() as { n: number };
    expect(logged.n).toBe(1); // the refused search did not reach the shop
  });

  it("conversations are per workspace", async () => {
    installTestDb();
    const msgs = [{ id: 0, from: "agent", text: "hi" }, { id: 1, from: "you", text: "secret A" }];
    const cookieA = cookieFrom(await putConversation(jsonReq(`${U}/api/conversation`, { shop: "loom-and-thread", messages: msgs }, {}, "PUT")));
    const get = async (cookie: string) =>
      (await (await getConversation(new Request(`${U}/api/conversation?shop=loom-and-thread`, { headers: { cookie } }))).json()) as { messages: unknown[] };
    expect((await get(cookieA)).messages).toHaveLength(2);
    const cookieB = cookieFrom(await getConversation(new Request(`${U}/api/conversation?shop=loom-and-thread`)));
    expect((await get(cookieB)).messages).toEqual([]);
    await putConversation(jsonReq(`${U}/api/conversation`, { shop: "loom-and-thread", messages: [{ id: 0, from: "you", text: "B only" }] }, { cookie: cookieB }, "PUT"));
    expect(JSON.stringify(await get(cookieA))).toContain("secret A");
    expect(JSON.stringify(await get(cookieA))).not.toContain("B only");
    expect(JSON.stringify(await get(cookieB))).not.toContain("secret A");
  });

  it("a conversation for a shop the workspace cannot see is refused", async () => {
    const { db } = installTestDb();
    const a = resolveWorkspace(db, new Headers()).id;
    createShop(db, a, { name: "Alpha Store", source_url: null, products: draft() });
    const res = await getConversation(new Request(`${U}/api/conversation?shop=alpha-store`));
    expect(res.status).toBe(404);
  });

  it("the demo state is rebuilt on seed: workspace shops vanish, the demo shop stays", () => {
    const { db } = installTestDb();
    const a = resolveWorkspace(db, new Headers()).id;
    createShop(db, a, { name: "Alpha Store", source_url: null, products: draft() });
    seed(db);
    expect((db.prepare("SELECT slug FROM shops").all() as { slug: string }[]).map((s) => s.slug)).toEqual(["loom-and-thread"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n).toBe(0);
  });
});

describe("publishing", () => {
  beforeEach(() => {
    installTestDb();
  });

  it("creates a shop owned by the caller, searchable through its MCP URL", async () => {
    const res = await publish(jsonReq(`${U}/api/shops`, { name: "My Test Shop", source_url: "https://x.example/", products: draft(3) }));
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toMatch(/ql_ws=ws_[a-f0-9]{32}; .*HttpOnly/);
    const body = (await res.json()) as { slug: string; mcp_url: string; products: number };
    expect(body).toMatchObject({ slug: "my-test-shop", mcp_url: `${U}/m/my-test-shop/mcp`, products: 3 });

    const { POST } = await import("@/app/m/[shop]/mcp/route");
    const rpc = await POST(
      new Request(body.mcp_url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_products", arguments: { query: "thing" } } }),
      }),
      { params: Promise.resolve({ shop: body.slug }) },
    );
    const out = (await rpc.json()) as { result: { structuredContent: { results: { sku: string }[] } } };
    expect(out.result.structuredContent.results.map((r) => r.sku)).toEqual(["S-1", "S-2", "S-3"]);
  });

  it("rejects an invalid edited draft with a reason and creates nothing", async () => {
    const { db } = installTestDb();
    const res = await publish(jsonReq(`${U}/api/shops`, { name: "Bad", products: [product(1), { ...product(2), price_cents: 0 }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/price/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM shops").get() as { n: number }).n).toBe(1);
    expect((await publish(jsonReq(`${U}/api/shops`, { name: "Empty", products: [] }))).status).toBe(400);
    expect((await publish(jsonReq(`${U}/api/shops`, { name: "  ", products: draft() }))).status).toBe(400);
  });

  it("keeps slugs unique and never reuses the demo slug", () => {
    const { db } = installTestDb();
    const ws = resolveWorkspace(db, new Headers()).id;
    const s1 = createShop(db, ws, { name: "Loom & Thread", source_url: null, products: draft() }).shop.slug;
    const s2 = createShop(db, ws, { name: "Loom & Thread", source_url: null, products: draft() }).shop.slug;
    expect([s1, s2]).toEqual(["loom-thread", "loom-thread-2"]);
    expect(createShop(db, ws, { name: "loom-and-thread", source_url: null, products: draft() }).shop.slug).toBe("loom-and-thread-2");
    expect(slugify("  !!  ")).toBe("shop");
  });

  it("caps shops per workspace", () => {
    const { db } = installTestDb();
    const ws = resolveWorkspace(db, new Headers()).id;
    for (let i = 0; i < MAX_SHOPS_PER_WORKSPACE; i++) createShop(db, ws, { name: `Shop ${i}`, source_url: null, products: draft() });
    expect(() => createShop(db, ws, { name: "One more", source_url: null, products: draft() })).toThrow(ShopError);
    const other = resolveWorkspace(db, new Headers()).id;
    expect(() => createShop(db, other, { name: "Fine", source_url: null, products: draft() })).not.toThrow();
  });

  it("stores only http(s) source URLs", async () => {
    const { db } = installTestDb();
    await publish(jsonReq(`${U}/api/shops`, { name: "Js", source_url: "javascript:alert(1)", products: draft() }));
    expect((db.prepare("SELECT source_url FROM shops WHERE slug = 'js'").get() as { source_url: string | null }).source_url).toBeNull();
  });
});

describe("API rate limits", () => {
  beforeEach(() => {
    installTestDb();
  });

  it("limits the chat endpoint per workspace", async () => {
    const first = await chat(jsonReq(`${U}/api/chat`, { action: "parse", text: "hello" }, { "x-forwarded-for": "10.9.0.1" }));
    const cookie = cookieFrom(first);
    let status = 200;
    for (let i = 0; i < 70 && status === 200; i++) {
      status = (await chat(jsonReq(`${U}/api/chat`, { action: "parse", text: "hello" }, { cookie, "x-forwarded-for": `10.9.1.${i}` }))).status;
    }
    expect(status).toBe(429);
  });

  it("limits the chat endpoint per IP when cookies are dropped", async () => {
    let status = 200;
    for (let i = 0; i < 130 && status === 200; i++) {
      status = (await chat(jsonReq(`${U}/api/chat`, { action: "parse", text: "hi" }, { "x-forwarded-for": "10.8.0.1" }))).status;
    }
    expect(status).toBe(429);
  });

  it("limits ingest and answers 429 with Retry-After", async () => {
    const csv = "title,price\nMug,5\n";
    let res = await ingest(jsonReq(`${U}/api/ingest`, { csv }, { "x-forwarded-for": "10.7.0.1" }));
    const cookie = cookieFrom(res);
    for (let i = 0; i < 8; i++) res = await ingest(jsonReq(`${U}/api/ingest`, { csv }, { cookie, "x-forwarded-for": `10.7.1.${i}` }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits checkout creation separately and more tightly than chat", async () => {
    const cookie = cookieFrom(await chat(jsonReq(`${U}/api/chat`, { action: "parse", text: "x" }, { "x-forwarded-for": "10.6.0.1" })));
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push((await chat(jsonReq(`${U}/api/chat`, { action: "checkout", shop: "loom-and-thread", quote_id: "nope" }, { cookie, "x-forwarded-for": `10.6.1.${i}` }))).status);
    }
    expect(statuses.slice(0, 9).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("limits create_checkout on the public MCP endpoint per IP", async () => {
    const { POST } = await import("@/app/m/[shop]/mcp/route");
    const call = () =>
      POST(
        new Request(`${U}/m/loom-and-thread/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "10.5.0.1" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_checkout", arguments: { quote_id: "nope" } } }),
        }),
        { params: Promise.resolve({ shop: "loom-and-thread" }) },
      );
    let status = 200;
    for (let i = 0; i < 25 && status === 200; i++) status = (await call()).status;
    expect(status).toBe(429);
  });
});

describe("ingest API", () => {
  beforeEach(() => {
    installTestDb();
  });

  async function events(res: Response): Promise<{ type: string; [k: string]: unknown }[]> {
    return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  }

  it("streams steps then a result for a CSV", async () => {
    const res = await ingest(jsonReq(`${U}/api/ingest`, { csv: "sku,title,price\nA,Mug,5\nB,Bowl,7.5\n" }));
    expect(res.headers.get("content-type")).toMatch(/ndjson/);
    const ev = await events(res);
    expect(ev.filter((e) => e.type === "step").length).toBeGreaterThanOrEqual(3);
    const result = ev.at(-1) as unknown as { type: string; result: { products: { sku: string }[] } };
    expect(result.type).toBe("result");
    expect(result.result.products.map((p) => p.sku)).toEqual(["A", "B"]);
  });

  it("ingests a /demo-shops URL on the app own origin", async () => {
    const res = await ingest(jsonReq(`${U}/api/ingest`, { url: `${U}/demo-shops/daily-grind` }));
    const last = (await events(res)).at(-1) as unknown as { type: string; result: { products: unknown[] } };
    expect(last.type).toBe("result");
    expect(last.result.products).toHaveLength(6);
  });

  it.each(["http://127.0.0.1/", "http://localhost:3000/admin", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://[::1]/"])(
    "refuses %s with an error event",
    async (url) => {
      const last = (await events(await ingest(jsonReq(`${U}/api/ingest`, { url })))).at(-1);
      expect(last?.type).toBe("error");
    },
  );

  it("reports a CSV problem as an error event and a bad body as 400", async () => {
    const last = (await events(await ingest(jsonReq(`${U}/api/ingest`, { csv: "foo,bar\n1,2\n" })))).at(-1);
    expect(last).toMatchObject({ type: "error" });
    expect((await ingest(jsonReq(`${U}/api/ingest`, { nope: 1 }))).status).toBe(400);
  });
});
