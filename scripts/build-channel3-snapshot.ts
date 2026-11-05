// Builds data/channel3-snapshot.json from live Channel3 calls. Run: npx tsx scripts/build-channel3-snapshot.ts
// Reads CHANNEL3_API_KEY from .env.local (never printed). At most 60 calls, paused between calls, stops on a 429.
import fs from "node:fs";
import path from "node:path";
import { Channel3Error, fetchLive, normaliseQuery, snapshotPath, type C3Product } from "../lib/channel3";
import { DEMO_PRODUCTS, DEMO_UNMET_QUERIES } from "../lib/seed-data";

const MAX_CALLS = 60;
const PAUSE_MS = 1500;

function readKey(): string | null {
  if (process.env.CHANNEL3_API_KEY) return process.env.CHANNEL3_API_KEY;
  try {
    const text = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    const m = text.match(/^\s*CHANNEL3_API_KEY\s*=\s*(.+?)\s*$/m);
    return m ? m[1].replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const key = readKey();
  if (!key) {
    console.error("CHANNEL3_API_KEY not found in the environment or .env.local. Nothing written.");
    process.exit(1);
  }
  const queries = [...new Set([...DEMO_UNMET_QUERIES, ...DEMO_PRODUCTS.map((p) => p.title)].map(normaliseQuery))].slice(0, MAX_CALLS);
  const file = snapshotPath();
  let entries: Record<string, C3Product[]> = {};
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8")).entries ?? {};
  } catch {
    entries = {};
  }
  let calls = 0;
  for (const q of queries) {
    if (calls >= MAX_CALLS) break;
    if (calls > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    calls += 1;
    try {
      entries[q] = await fetchLive(q, key, fetch, 15000);
      console.log(`ok   ${String(entries[q].length).padStart(2)} products  ${q}`);
    } catch (e) {
      const status = e instanceof Channel3Error ? e.status : null;
      console.log(`FAIL ${status ?? "network"}  ${q}`);
      if (status === 429) {
        console.log("Rate limited (429): stopping. Keeping what was collected.");
        break;
      }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), entries }, null, 1) + "\n");
  console.log(`Wrote ${Object.keys(entries).length} entries (${calls} live calls) to ${path.relative(process.cwd(), file)}`);
}

void main();
