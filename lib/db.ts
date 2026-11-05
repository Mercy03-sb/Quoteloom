import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { databasePath } from "./config";
import { SCHEMA, TABLES } from "./schema";
import { seed } from "./seed";

export type DB = Database.Database;

/** Open a database and make sure the schema exists. ":memory:" is allowed. */
export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  dropStaleSchema(db);
  db.exec(SCHEMA);
  return db;
}

/** State is disposable: a DB file from before multi-shop or dispute support is dropped and rebuilt, not migrated. */
function dropStaleSchema(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(shops)").all() as { name: string }[];
  if (cols.length === 0) return;
  const dcols = db.prepare("PRAGMA table_info(disputes)").all() as { name: string }[];
  const scols = db.prepare("PRAGMA table_info(search_log)").all() as { name: string }[];
  if (cols.some((c) => c.name === "workspace_id") && dcols.some((c) => c.name === "simulated") && scols.some((c) => c.name === "is_demo")) return;
  db.pragma("foreign_keys = OFF");
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.pragma("foreign_keys = ON");
}

const g = globalThis as unknown as { __quoteloomDb?: DB };

/**
 * Process-wide DB handle. On first open the demo state is restored
 * (SPEC: "SQLite, seeded on every boot"), so a fresh process always starts clean.
 */
export function getDb(): DB {
  if (!g.__quoteloomDb) {
    const db = openDb(databasePath());
    seed(db);
    g.__quoteloomDb = db;
  }
  return g.__quoteloomDb;
}
