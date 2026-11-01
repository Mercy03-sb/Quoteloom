// Runtime AI provider: Gemini free tier through plain fetch, with a cache keyed by input hash.
// Never throws: callers get { ok: false } and fall back to deterministic code. No key means no network call.
// The model only drafts or proposes; it never sets a price that the app commits to.
import { createHash } from "node:crypto";
import type { DB } from "./db";

type Env = Record<string, string | undefined>;

export type LlmFailure = {
  ok: false;
  reason: "no_key" | "rate_limited" | "cooldown" | "http_error" | "network" | "empty";
  /** HTTP status, when the API answered. */
  status?: number;
  /** Error code or status string from the response body (for example NOT_FOUND), or a network error code. */
  code?: string;
  /** Short message from the API or the network error, with the key removed. */
  detail?: string;
};
export type LlmResult = { ok: true; text: string; cached: boolean } | LlmFailure;

/** Strip the key from any text and cut it short, so it is safe for logs and the UI. */
export function redact(text: string, key: string | undefined): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (key) t = t.split(key).join("[redacted]");
  t = t.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/** One line for the banner and the log, for example "Gemini 404: model not found (NOT_FOUND)". */
export function describeFailure(f: LlmFailure): string {
  if (f.reason === "no_key") return "Gemini has no API key";
  if (f.reason === "cooldown") return "Gemini paused after a rate limit; retrying shortly";
  const head = f.status ? `Gemini ${f.status}` : "Gemini request failed";
  const msg = f.detail ? `: ${f.detail}` : f.reason === "network" ? ": could not reach the API" : "";
  return `${head}${msg}${f.code ? ` (${f.code})` : ""}`;
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"; // fast and steady in testing; gemini-3.8-flash 503s or times out at times
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
  const key = env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, "").trim(); // pasted keys often carry a newline or quotes
  if (!key) return { ok: false, reason: "no_key" };
  const model = env.GEMINI_MODEL?.trim().replace(/^["']|["']$/g, "").replace(/^models\//, "").trim() || DEFAULT_GEMINI_MODEL;
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
        signal: AbortSignal.timeout(o.timeoutMs ?? 12_000),
      },
    );
    if (!res.ok) {
      const err = await apiError(res, key);
      if (res.status === 429) g.__quoteloomLlmCooldownUntil = now + COOLDOWN_MS; // stop hammering a rate-limited key
      const fail: LlmFailure = { ok: false, reason: res.status === 429 ? "rate_limited" : "http_error", status: res.status, ...err };
      console.warn(`[llm] ${describeFailure(fail)} (model=${model})`);
      return fail;
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) {
      const reason = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason;
      const fail: LlmFailure = { ok: false, reason: "empty", status: res.status, detail: reason ? `no text returned (${reason})` : "no text returned" };
      console.warn(`[llm] ${describeFailure(fail)} (model=${model})`);
      return fail;
    }
    o.db.prepare("INSERT OR REPLACE INTO llm_cache (hash, response_json) VALUES (?, ?)").run(hash, text);
    return { ok: true, text, cached: false };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const code = err.cause?.code ?? (err.name === "TimeoutError" ? "TIMEOUT" : err.name);
    const fail: LlmFailure = { ok: false, reason: "network", code, detail: redact(err.cause?.message ?? err.message ?? "request failed", key) };
    console.warn(`[llm] ${describeFailure(fail)} (model=${model})`);
    return fail;
  }
}

/** Pull the error status string and message out of a Google API error body: {"error":{"code":404,"message":"..","status":"NOT_FOUND"}}. */
async function apiError(res: Response, key: string): Promise<{ code?: string; detail?: string }> {
  const raw = await res.text().catch(() => "");
  try {
    const e = (JSON.parse(raw) as { error?: { status?: string; message?: string; code?: number } }).error;
    if (e) return { code: e.status ?? (e.code ? String(e.code) : undefined), detail: e.message ? redact(e.message, key) : undefined };
  } catch {
    /* not JSON */
  }
  return { detail: raw ? redact(raw, key) : undefined };
}

export function resetLlmCooldown(): void {
  g.__quoteloomLlmCooldownUntil = 0;
}
