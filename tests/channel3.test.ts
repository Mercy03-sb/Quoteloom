import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lookupChannel3, normaliseQuery, reduceProducts, resetChannel3State, type FetchLike } from "@/lib/channel3";
import { limiter } from "@/lib/ratelimit";
import { seededDb } from "./helpers";

const raw = {
  products: [
    { title: "Wool scarf", images: [{ url: "https://cdn.trychannel3.com/a", cleaned_url: "https://cdn.trychannel3.com/c" }], offers: [
      { url: "https://buy.trychannel3.com/x", domain: "shop.example", price: { price: 40, currency: "usd" }, availability: "OutOfStock" },
      { url: "https://buy.trychannel3.com/y", domain: "other.example", price: { price: 45, currency: "USD" }, availability: "InStock" },
    ] },
    { title: "No offers", offers: [] },
  ],
};
const okFetch = (): FetchLike & { calls: number } => {
  const f: FetchLike & { calls: number } = Object.assign(
    async () => {
      f.calls += 1;
      return new Response(JSON.stringify(raw), { status: 200 });
    },
    { calls: 0 },
  );
  return f;
};

let snapFile: string;
beforeEach(() => {
  resetChannel3State();
  limiter().reset();
  snapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c3-")), "snap.json");
  fs.writeFileSync(snapFile, JSON.stringify({ generated_at: "x", entries: { "wool scarf": [{ title: "Snap", image: null, retailer: "s.example", price: 50, currency: "USD", in_stock: true, url: "u" }] } }));
});

describe("channel3 reduce", () => {
  it("keeps the cheapest in-stock offer, uses cleaned image, drops products without offers", () => {
    const r = reduceProducts(raw);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ retailer: "other.example", price: 45, in_stock: true, image: "https://cdn.trychannel3.com/c" });
  });
  it("normalises queries", () => {
    expect(normaliseQuery("  Merino  Wool-Scarf! ")).toBe("merino wool scarf");
  });
});

describe("channel3 lookup order", () => {
  it("live first, then cached on the second call (one network call)", async () => {
    const { db } = seededDb();
    const f = okFetch();
    const env = { CHANNEL3_API_KEY: "k" };
    const a = await lookupChannel3(db, "Wool scarf", { env, fetchImpl: f, snapshotFile: snapFile });
    const b = await lookupChannel3(db, "wool  scarf", { env, fetchImpl: f, snapshotFile: snapFile });
    expect([a.source, b.source]).toEqual(["live", "cached"]);
    expect(f.calls).toBe(1);
  });
  it("falls back to the snapshot when the key is unset (no network call)", async () => {
    const { db } = seededDb();
    const f = okFetch();
    const r = await lookupChannel3(db, "wool scarf", { env: {}, fetchImpl: f, snapshotFile: snapFile });
    expect(r.source).toBe("snapshot");
    expect(f.calls).toBe(0);
  });
  it("falls back to the snapshot when the live call fails or times out", async () => {
    const { db } = seededDb();
    const boom: FetchLike = async () => {
      throw new Error("down");
    };
    const r = await lookupChannel3(db, "wool scarf", { env: { CHANNEL3_API_KEY: "k" }, fetchImpl: boom, snapshotFile: snapFile });
    expect(r.source).toBe("snapshot");
  });
  it("on 429 falls through, does not retry, and stops calling for a while", async () => {
    const { db } = seededDb();
    let n = 0;
    const f: FetchLike = async () => {
      n += 1;
      return new Response("{}", { status: 429 });
    };
    const ctx = { env: { CHANNEL3_API_KEY: "k" }, fetchImpl: f, snapshotFile: snapFile };
    expect((await lookupChannel3(db, "wool scarf", ctx)).source).toBe("snapshot");
    await lookupChannel3(db, "wool scarf", ctx);
    await lookupChannel3(db, "other thing", ctx);
    expect(n).toBe(1);
  });
  it("returns nothing when there is no key, no cache and no snapshot entry", async () => {
    const { db } = seededDb();
    const r = await lookupChannel3(db, "unknown thing", { env: {}, snapshotFile: snapFile });
    expect(r).toMatchObject({ source: "none", products: [] });
  });
  it("works with a missing snapshot file", async () => {
    const { db } = seededDb();
    const r = await lookupChannel3(db, "wool scarf", { env: {}, snapshotFile: path.join(os.tmpdir(), "nope-" + Date.now() + ".json") });
    expect(r.source).toBe("none");
  });
});

describe("channel3 rate limit", () => {
  it("per IP: past the limit live calls stop and the snapshot answers", async () => {
    const { db } = seededDb();
    const f = okFetch();
    const ctx = { env: { CHANNEL3_API_KEY: "k" }, fetchImpl: f, snapshotFile: snapFile, ip: "1.2.3.4", workspace: null };
    for (let i = 0; i < 45; i++) await lookupChannel3(db, `wool scarf ${i}`, ctx);
    expect(f.calls).toBe(40);
    const r = await lookupChannel3(db, "wool scarf", ctx);
    expect(r.source).toBe("snapshot");
  });
  it("per workspace", async () => {
    const { db } = seededDb();
    const f = okFetch();
    for (let i = 0; i < 25; i++) await lookupChannel3(db, `q ${i}`, { env: { CHANNEL3_API_KEY: "k" }, fetchImpl: f, snapshotFile: snapFile, ip: `9.9.9.${i}`, workspace: "ws1" });
    expect(f.calls).toBe(20);
  });
});
