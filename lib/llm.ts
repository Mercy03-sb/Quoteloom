// Runtime AI provider: Gemini free tier through plain fetch, with a cache keyed by input hash.
// Never throws: callers get { ok: false } and fall back to deterministic code. No key means no network call.
// The model only drafts or proposes; it never sets a price that the app commits to.
import { createHash } from "node:crypto";
import type { DB } from "./db";

type Env = Record<string, string | undefined>;

export type LlmResult =
  | { ok: true; text: string; cached: boolean }
  | { ok: false; reason: "no_key" | "rate_limited" | "cooldown" | "http_error" | "network" | "empty" };

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
const COOLDOWN_MS = 60_000;
const g = globalThis as unknown as { __quoteloomLlmCooldownUntil?: number };

export function inputHash(model: string, system: string, input: string): string {
  return createHash("sha256").update(`${model}\n${system}\n${input}`).digest("hex");
}

export type GenerateOptions = {
  db: DB;
  system: string;
  input: string;
  env?: Env;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

/** Ask Gemini for JSON text. Cached by hash of (model, system, input); failures are never cached. */
export async function generateJson(o: GenerateOptions): Promise<LlmResult> {
  const env = o.env ?? process.env;
  const key = env.GEMINI_API_KEY;
  if (!key) return { ok: false, reason: "no_key" };
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const hash = inputHash(model, o.system, o.input);

  const hit = o.db.prepare("SELECT response_json FROM llm_cache WHERE hash = ?").get(hash) as { response_json: string } | undefined;
  if (hit) return { ok: true, text: hit.response_json, cached: true };

  const now = (o.now ?? Date.now)();
  if ((g.__quoteloomLlmCooldownUntil ?? 0) > now) return { ok: false, reason: "cooldown" };

  try {
    const res = await (o.fetchImpl ?? fetch)(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: o.system }] },
          contents: [{ role: "user", parts: [{ text: o.input }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      },
    );
    if (res.status === 429) {
      g.__quoteloomLlmCooldownUntil = now + COOLDOWN_MS; // stop hammering a rate-limited key
      return { ok: false, reason: "rate_limited" };
    }
    if (!res.ok) return { ok: false, reason: "http_error" };
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) return { ok: false, reason: "empty" };
    o.db.prepare("INSERT OR REPLACE INTO llm_cache (hash, response_json) VALUES (?, ?)").run(hash, text);
    return { ok: true, text, cached: false };
  } catch {
    return { ok: false, reason: "network" };
  }
}

export function resetLlmCooldown(): void {
  g.__quoteloomLlmCooldownUntil = 0;
}
