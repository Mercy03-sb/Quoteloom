// Runtime AI provider: Gemini free tier through plain fetch, with a cache keyed by input hash.
// Never throws: callers get { ok: false } and fall back to deterministic code. No key means no network call.
// The model only drafts or proposes; it never sets a price that the app commits to.
// On a 429 or 503 the call moves to the next model in FALLBACK_MODELS; a model that answered 429 rests for a while (see cooldowns).
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
  /** For a 429: the quota that ran out looks daily (per-day), not per-minute. */
  daily?: boolean;
  /** How many HTTP calls this request made across the fallback models (0 when every model was cooling down). */
  attempts?: number;
};
export type LlmResult = { ok: true; text: string; cached: boolean } | LlmFailure;

/** Strip the key from any text and cut it short, so it is safe for logs and the UI. */
export function redact(text: string, key: string | undefined): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (key) t = t.split(key).join("[redacted]");
  t = t.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/** One line for the server log, for example "Gemini 404: model not found (NOT_FOUND)". Not for the browser: see failureToError. */
export function describeFailure(f: LlmFailure): string {
  if (f.reason === "no_key") return "Gemini has no API key";
  if (f.reason === "cooldown") return "Gemini paused after a rate limit; retrying shortly";
  const head = f.status ? `Gemini ${f.status}` : "Gemini request failed";
  const msg = f.detail ? `: ${f.detail}` : f.reason === "network" ? ": could not reach the API" : "";
  return `${head}${msg}${f.code ? ` (${f.code})` : ""}`;
}

/** The configured key with pasted newlines or quotes removed, or undefined. Never log it. */
export function geminiKey(env: Env = process.env): string | undefined {
  return env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, "").trim() || undefined;
}
/** Model from GEMINI_MODEL (a leading "models/" is accepted), else the default. */
export function geminiModel(env: Env = process.env): string {
  return env.GEMINI_MODEL?.trim().replace(/^["']|["']$/g, "").replace(/^models\//, "").trim() || DEFAULT_GEMINI_MODEL;
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"; // fast and steady in testing; gemini-3.8-flash 503s or times out at times

/**
 * Models tried in order when the preferred one is rate limited or overloaded. Ids confirmed with `npm run check:gemini -- --models`.
 * Free tier: the two Flash Lite models allow 15 requests/minute and 500/day; 3.6 and 3.8 Flash only 5/minute and 20/day, so they come last.
 */
export const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"] as const;
/** Never make more than this many HTTP calls for one request, so a bad hour cannot stretch one answer over minutes. */
const MAX_ATTEMPTS = 4;
const MINUTE_COOLDOWN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The preferred model (GEMINI_MODEL) first, then the fallbacks in order, without repeats. */
export function modelChain(env: Env = process.env): string[] {
  return [...new Set<string>([geminiModel(env), ...FALLBACK_MODELS])];
}

// model id -> epoch ms until which it is not called (it answered 429)
const g = globalThis as unknown as { __quoteloomCooldowns?: Map<string, number> };
const cooldowns = (): Map<string, number> => (g.__quoteloomCooldowns ??= new Map());
/** Per-minute limit: 60 s. Anything that looks daily: until the next UTC hour, so a reset is noticed within the hour without hammering. */
const cooldownUntil = (now: number, daily: boolean): number => (daily ? (Math.floor(now / HOUR_MS) + 1) * HOUR_MS : now + MINUTE_COOLDOWN_MS);
const coolingDown = (model: string, now: number): boolean => (cooldowns().get(model) ?? 0) > now;
/** Models currently skipped after a 429 (for tests and logs). */
export function coolingModels(now = Date.now()): string[] {
  return [...cooldowns()].filter(([, until]) => until > now).map(([m]) => m);
}
export function resetLlmCooldown(): void {
  cooldowns().clear();
}

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

/** Ask Gemini for JSON text. Cached by hash of (model, system, input); failures are never cached. Falls back across models on 429/503. */
export async function generateJson(o: GenerateOptions): Promise<LlmResult> {
  const env = o.env ?? process.env;
  const key = geminiKey(env);
  if (!key) return { ok: false, reason: "no_key" };
  const hash = inputHash(geminiModel(env), o.system, o.input);

  const hit = o.db.prepare("SELECT response_json FROM llm_cache WHERE hash = ?").get(hash) as { response_json: string } | undefined;
  if (hit) return { ok: true, text: hit.response_json, cached: true };

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: o.system }] },
    contents: [{ role: "user", parts: [{ text: o.input }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  });
  const r = await runChain(env, key, body, o.timeoutMs ?? 12_000, o.fetchImpl, (o.now ?? Date.now)(), (json, status) => {
    const parsed = json as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    const text = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (text.trim()) return { text };
    const reason = parsed.promptFeedback?.blockReason ?? parsed.candidates?.[0]?.finishReason;
    return { rejected: true, status, detail: reason ? `no text returned (${reason})` : "no text returned" };
  });
  if (!r.ok) return r;
  const text = r.value.text as string;
  o.db.prepare("INSERT OR REPLACE INTO llm_cache (hash, response_json) VALUES (?, ?)").run(hash, text);
  return { ok: true, text, cached: false };
}

type Parsed = Record<string, unknown>;
/** What `parse` returns for a 200 answer it cannot use. It is not a transport error, so the chain stops. */
type Rejection = { rejected: true; status: number; detail: string };
type Chained = { ok: true; model: string; value: Parsed; attempts: number } | LlmFailure;

/**
 * POST `body` to each model in turn until one answers. A 429 (that model then rests, see cooldownUntil), 503, 500 or 404 moves on to
 * the next model; anything else stops. Models on cooldown are skipped without a call. Every real error is logged with the model and
 * status (never the key); callers decide what the user sees.
 */
async function runChain(
  env: Env,
  key: string,
  body: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  now: number,
  parse: (json: unknown, status: number) => Parsed | Rejection,
): Promise<Chained> {
  let last: LlmFailure | undefined;
  let attempts = 0;
  for (const model of modelChain(env)) {
    if (attempts >= MAX_ATTEMPTS) break;
    if (coolingDown(model, now)) continue;
    attempts += 1;
    const r = await post(model, key, body, timeoutMs, fetchImpl, now);
    if (r.ok) {
      const parsed = parse(r.json, r.status);
      if ("rejected" in parsed && parsed.rejected === true) {
        const fail: LlmFailure = { ok: false, reason: "empty", status: (parsed as Rejection).status, detail: (parsed as Rejection).detail, attempts };
        console.warn(`[llm] ${describeFailure(fail)} (model=${model})`);
        return fail;
      }
      return { ok: true, model, value: parsed, attempts };
    }
    last = { ...r.fail, attempts };
    const retryable = r.fail.status === 429 || r.fail.status === 503 || r.fail.status === 500 || r.fail.status === 404;
    if (!retryable) return last;
    if (attempts < MAX_ATTEMPTS) console.warn(`[llm] trying the next model after ${model}`);
  }
  if (last) return last;
  // Every model is resting: say whether any of them hit a daily limit.
  const daily = [...cooldowns().values()].some((until) => until - now > MINUTE_COOLDOWN_MS);
  return { ok: false, reason: "cooldown", daily, attempts: 0 };
}

async function post(
  model: string,
  key: string,
  body: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  now: number,
): Promise<{ ok: true; json: unknown; status: number } | { ok: false; fail: LlmFailure }> {
  try {
    const res = await (fetchImpl ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = await apiError(res, key);
      if (res.status === 429) cooldowns().set(model, cooldownUntil(now, Boolean(err.daily)));
      const fail: LlmFailure = { ok: false, reason: res.status === 429 ? "rate_limited" : "http_error", status: res.status, ...err };
      console.warn(`[llm] ${describeFailure(fail)} (model=${model})`);
      return { ok: false, fail };
    }
    return { ok: true, json: await res.json(), status: res.status };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const code = err.cause?.code ?? (err.name === "TimeoutError" ? "TIMEOUT" : err.name);
    const fail: LlmFailure = { ok: false, reason: "network", code, detail: redact(err.cause?.message ?? err.message ?? "request failed", key) };
    console.warn(`[llm] ${describeFailure(fail)} (model=${model})`);
    return { ok: false, fail };
  }
}

/** Pull the error status string and message out of a Google API error body: {"error":{"code":404,"message":"..","status":"NOT_FOUND"}}. */
async function apiError(res: Response, key: string): Promise<{ code?: string; detail?: string; daily?: boolean }> {
  const raw = await res.text().catch(() => "");
  const daily = res.status === 429 && /PerDay|per day|daily/i.test(raw); // e.g. quotaId "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
  try {
    const e = (JSON.parse(raw) as { error?: { status?: string; message?: string; code?: number } }).error;
    if (e) return { code: e.status ?? (e.code ? String(e.code) : undefined), detail: e.message ? redact(e.message, key) : undefined, daily };
  } catch {
    /* not JSON */
  }
  return { detail: raw ? redact(raw, key) : undefined, daily };
}

// ---- Tool-calling turns (used by the AG Studio assistant route) ----------------------------------------------------

export type GeminiPart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name: string; args?: Record<string, unknown> } };
export type TokenUsage = { inputTokens: number; outputTokens: number };
export type TurnResult = { ok: true; model: string; parts: GeminiPart[]; finishReason?: string; usage: TokenUsage; attempts: number } | LlmFailure;
export type TurnOptions = {
  /** A generateContent body: contents, systemInstruction, tools, toolConfig, generationConfig. */
  body: Record<string, unknown>;
  env?: Env;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

/**
 * One generateContent call with the caller's body (tool declarations included). Not cached. Starts with GEMINI_MODEL and falls back
 * across FALLBACK_MODELS on 429/503. Never throws.
 */
export async function generateTurn(o: TurnOptions): Promise<TurnResult> {
  const env = o.env ?? process.env;
  const key = geminiKey(env);
  if (!key) return { ok: false, reason: "no_key" };
  const r = await runChain(env, key, JSON.stringify(o.body), o.timeoutMs ?? 20_000, o.fetchImpl, (o.now ?? Date.now)(), (json, status) => {
    const body = json as {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const cand = body.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    if (!parts.some((p) => (p.text && !p.thought) || p.functionCall)) {
      const reason = body.promptFeedback?.blockReason ?? cand?.finishReason;
      return { rejected: true, status, detail: reason ? `no answer returned (${reason})` : "no answer returned" };
    }
    const usage: TokenUsage = { inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0 };
    return { parts, finishReason: cand?.finishReason, usage };
  });
  if (!r.ok) return r;
  const v = r.value as { parts: GeminiPart[]; finishReason?: string; usage: TokenUsage };
  return { ok: true, model: r.model, parts: v.parts, finishReason: v.finishReason, usage: v.usage, attempts: r.attempts };
}
