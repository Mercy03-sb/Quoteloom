import { databasePath } from "../lib/config";
import { openDb } from "../lib/db";
import { seed } from "../lib/seed";

const file = databasePath();
const db = openDb(file);
const result = seed(db);
db.close();
console.log(`Seeded ${file}: ${result.shops} shop, ${result.products} products.`);
