import { getShop, type Shop } from "@/lib/catalog";
import { openDb, type DB } from "@/lib/db";
import { seed } from "@/lib/seed";
import { DEMO_SHOP } from "@/lib/seed-data";

export function seededDb(): { db: DB; shop: Shop } {
  const db = openDb(":memory:");
  seed(db);
  const shop = getShop(db, DEMO_SHOP.slug);
  if (!shop) throw new Error("demo shop missing after seed");
  return { db, shop };
}
