import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { databasePath } from "./config";
import { SCHEMA } from "./schema";
import { seed } from "./seed";

export type DB = Database.Database;

/** Open a database and make sure the schema exists. ":memory:" is allowed. */
export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
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
