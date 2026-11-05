import { getShop, type Shop } from "@/lib/catalog";
import { openDb, type DB } from "@/lib/db";
import { seed } from "@/lib/seed";
import { DEMO_SHOP } from "@/lib/seed-data";

/** Point getDb() (used by route handlers and pages) at a fresh seeded in-memory DB, and reset rate limits. */
export function installTestDb(): { db: DB; shop: Shop } {
  const s = seededDb();
  (globalThis as unknown as { __quoteloomDb?: DB }).__quoteloomDb = s.db;
  (globalThis as unknown as { __quoteloomLimiter?: { reset(): void } }).__quoteloomLimiter?.reset();
  return s;
}

export const jsonReq = (url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  new Request(url, { method, headers: { "content-type": "application/json", host: "localhost:3000", ...headers }, body: JSON.stringify(body) });

/** "ql_ws=..." from a response Set-Cookie, as a request Cookie header. */
export const cookieFrom = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0];

export function seededDb(): { db: DB; shop: Shop } {
  const db = openDb(":memory:");
  seed(db, { demoHistory: false }); // most tests assume empty orders, disputes and search log
  const shop = getShop(db, DEMO_SHOP.slug);
  if (!shop) throw new Error("demo shop missing after seed");
  return { db, shop };
}
