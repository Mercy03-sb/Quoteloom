// npm run check:gemini: one tiny Gemini call with the configured key and model, to debug "Gemini unavailable".
// Reads .env.local / .env (without overriding real environment variables). Never prints the key.
import fs from "node:fs";
import { openDb } from "../lib/db";
import { DEFAULT_GEMINI_MODEL, describeFailure, generateJson } from "../lib/llm";

for (const file of [".env.local", ".env"]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  const key = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  console.log(`GEMINI_API_KEY: ${key ? `set (${key.length} chars)` : "NOT SET"}`);
  console.log(`Model: ${model}${process.env.GEMINI_MODEL?.trim() ? "" : " (default; GEMINI_MODEL is empty)"}`);
  if (!key) process.exit(1);
  if (process.argv.includes("--models")) return listModels(key);
  const started = Date.now();
  const r = await generateJson({
    db: openDb(":memory:"),
    system: 'Reply with JSON only: {"ok":true}',
    input: "ping",
    timeoutMs: 15_000,
  });
  const ms = Date.now() - started;
  if (r.ok) {
    console.log(`OK in ${ms} ms. Response: ${r.text.slice(0, 120)}`);
    return;
  }
  console.log(`FAILED in ${ms} ms: ${describeFailure(r)}`);
  console.log(`  reason=${r.reason} status=${r.status ?? "-"} code=${r.code ?? "-"}`);
  process.exit(1);
}

/** npm run check:gemini -- --models : names this key can call with generateContent. */
async function listModels(key: string): Promise<void> {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; error?: { status?: string; message?: string } };
    if (!res.ok) return void console.log(`Gemini ${res.status}: ${body.error?.message ?? "error"} (${body.error?.status ?? "-"})`);
    const names = (body.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
    console.log(`Models that support generateContent (${names.length}):`);
    for (const n of names) console.log(`  ${n}`);
  } catch (e) {
    console.log(`Could not list models: ${(e as Error).name}: ${(e as Error).message}`);
  }
}

void main();
