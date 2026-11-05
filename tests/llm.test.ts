import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "@/lib/db";
import { coolingModels, describeFailure, generateJson, modelChain, redact, resetLlmCooldown } from "@/lib/llm";
import { ingestUrl, type PageFetcher } from "@/lib/ingest/pipeline";

// Built at runtime so no key-shaped literal appears in source (GitHub secret scanning).
const PREFIX = ["AI", "za"].join("");
const KEY = PREFIX + ["SyFAKEKEY", "0123456789", "abcdefghijklmnop"].join("");
const env = { GEMINI_API_KEY: KEY, GEMINI_MODEL: "gemini-test-model" };
const run = (fetchImpl: unknown, e: Record<string, string | undefined> = env) =>
  generateJson({ db: openDb(":memory:"), system: "s", input: "i", env: e, fetchImpl: fetchImpl as typeof fetch });
const apiError = (status: number, errStatus: string, message: string) =>
  new Response(JSON.stringify({ error: { code: status, message, status: errStatus } }), { status });

beforeEach(() => {
  vi.restoreAllMocks();
  resetLlmCooldown();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Gemini failure reporting", () => {
  it("reports status, API error code and message for a 404 (wrong model name)", async () => {
    const r = await run(async () => apiError(404, "NOT_FOUND", "models/gemini-test-model is not found for API version v1beta"));
    expect(r).toMatchObject({ ok: false, reason: "http_error", status: 404, code: "NOT_FOUND" });
    expect(describeFailure(r as never)).toBe("Gemini 404: models/gemini-test-model is not found for API version v1beta (NOT_FOUND)");
  });

  it("reports a 503 overload and a 400 bad key distinctly, and a 429 as rate limited", async () => {
    expect(describeFailure((await run(async () => apiError(503, "UNAVAILABLE", "This model is currently experiencing high demand."))) as never)).toMatch(/^Gemini 503: .*high demand.* \(UNAVAILABLE\)$/);
    expect(describeFailure((await run(async () => apiError(400, "INVALID_ARGUMENT", "API key not valid."))) as never)).toMatch(/^Gemini 400: API key not valid\. \(INVALID_ARGUMENT\)$/);
    resetLlmCooldown();
    expect(await run(async () => apiError(429, "RESOURCE_EXHAUSTED", "Quota exceeded"))).toMatchObject({ reason: "rate_limited", status: 429, code: "RESOURCE_EXHAUSTED" });
  });

  it("copes with a non-JSON error body", async () => {
    const r = await run(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(describeFailure(r as never)).toBe("Gemini 502: <html>Bad gateway</html>");
  });

  it("reports a timeout and a network failure with their codes, not just 'network'", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(describeFailure((await run(async () => { throw timeout; })) as never)).toBe("Gemini request failed: The operation was aborted due to timeout (TIMEOUT)");
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND generativelanguage.googleapis.com" } });
    expect(describeFailure((await run(async () => { throw dns; })) as never)).toBe(
      "Gemini request failed: getaddrinfo ENOTFOUND generativelanguage.googleapis.com (ENOTFOUND)",
    );
  });

  it("reports an empty or blocked answer", async () => {
    const r = await run(async () => new Response(JSON.stringify({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }));
    expect(describeFailure(r as never)).toBe("Gemini 200: no text returned (SAFETY)");
  });

  it("never leaks the key: not in the URL, the logs, the message or the banner", async () => {
    const calls: string[] = [];
    const leaky = async (url: string) => {
      calls.push(url);
      return apiError(400, "INVALID_ARGUMENT", `API key ${KEY} not valid. Please pass a valid API key.`);
    };
    const r = await run(leaky);
    const text = JSON.stringify(r) + describeFailure(r as never) + (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ") + calls.join(" ");
    expect(text).not.toContain(KEY);
    expect(text).toContain("[redacted]");
    expect(redact(`oops ${PREFIX}${"x".repeat(35)} oops`, undefined)).toBe("oops [redacted] oops");
  });

  it("logs one line with the reason and model", async () => {
    await run(async () => apiError(404, "NOT_FOUND", "model not found"));
    const line = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(line).toBe("[llm] Gemini 404: model not found (NOT_FOUND) (model=gemini-test-model)");
  });

  it("tolerates a key or model pasted with quotes, spaces, a newline or a models/ prefix", async () => {
    const urls: string[] = [];
    const headers: string[] = [];
    const ok = async (url: string, init: RequestInit) => {
      urls.push(url);
      headers.push((init.headers as Record<string, string>)["x-goog-api-key"]);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), { status: 200 });
    };
    const r = await run(ok, { GEMINI_API_KEY: `"${KEY}"\n`, GEMINI_MODEL: ' "models/gemini-3.5-flash-lite" ' });
    expect(r).toMatchObject({ ok: true });
    expect(headers[0]).toBe(KEY);
    expect(urls[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  });

  it("uses the default model when GEMINI_MODEL is empty, and says no key when there is none", async () => {
    const urls: string[] = [];
    await run(async (url: string) => { urls.push(url); return apiError(500, "INTERNAL", "x"); }, { GEMINI_API_KEY: KEY, GEMINI_MODEL: "" });
    expect(urls[0]).toContain("/models/gemini-3.5-flash-lite:");
    expect(await run(vi.fn(), {})).toEqual({ ok: false, reason: "no_key" });
  });
});

describe("ingest banner shows the real Gemini error", () => {
  it("includes status and message in the warning", async () => {
    const page: PageFetcher = async (u) => ({
      url: u, status: 200, contentType: "text/html",
      text: '<p>Welcome to our little shop. We sell hand made things every week.</p><li class="product-card"><h3>Socks</h3><span>$12.00</span></li>',
    });
    const r = await ingestUrl(openDb(":memory:"), "https://shop.example/", {
      fetchPage: page,
      selfOrigin: null,
      env,
      fetchImpl: (async () => apiError(404, "NOT_FOUND", "model not found")) as unknown as typeof fetch,
    });
    expect(r.warnings).toContain("Gemini 404: model not found (NOT_FOUND); used the rule-based parser.");
    expect(r.methods.rules).toBe(1);
  });
});

describe("model fallback and cooldown", () => {
  const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), { status: 200 });
  const modelOf = (url: string) => /models\/([^:]+):/.exec(url)?.[1];
  const preferred = { GEMINI_API_KEY: KEY, GEMINI_MODEL: "" };
  const at = (now: number) => ({ db: openDb(":memory:"), system: "s", input: `i${now}${Math.random()}`, env: preferred, now: () => now });

  it("lists the chain with the preferred model first and no repeats", () => {
    expect(modelChain({ GEMINI_MODEL: "" })).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"]);
    expect(modelChain({ GEMINI_MODEL: "gemini-3.6-flash" })).toEqual(["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]);
  });

  it("moves to the next model on a 429, then on a 503, in the documented order", async () => {
    const seen: (string | undefined)[] = [];
    const f = async (url: string) => {
      seen.push(modelOf(url));
      if (seen.length === 1) return apiError(429, "RESOURCE_EXHAUSTED", "Quota exceeded: RequestsPerMinute");
      if (seen.length === 2) return apiError(503, "UNAVAILABLE", "overloaded");
      return ok();
    };
    const r = await generateJson({ ...at(1_000_000), fetchImpl: f as never });
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(seen).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash"]);
  });

  it("rests a 429 model for 60 s (per-minute) and does not call it again until then", async () => {
    const seen: (string | undefined)[] = [];
    const f = async (url: string) => {
      seen.push(modelOf(url));
      return modelOf(url) === "gemini-3.5-flash-lite" ? apiError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for RequestsPerMinute") : ok();
    };
    await generateJson({ ...at(1_000_000), fetchImpl: f as never });
    expect(coolingModels(1_000_001)).toEqual(["gemini-3.5-flash-lite"]);
    seen.length = 0;
    await generateJson({ ...at(1_030_000), fetchImpl: f as never });
    expect(seen).toEqual(["gemini-3.1-flash-lite"]); // first model skipped without a call
    seen.length = 0;
    await generateJson({ ...at(1_061_000), fetchImpl: f as never });
    expect(seen).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]); // tried again after 60 s
  });

  it("rests a model with a daily quota until the next UTC hour", async () => {
    const t = Date.UTC(2026, 10, 6, 10, 20, 0);
    const f = async (url: string) =>
      modelOf(url) === "gemini-3.5-flash-lite"
        ? new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] } }), { status: 429 })
        : ok();
    await generateJson({ ...at(t), fetchImpl: f as never });
    expect(coolingModels(t + 30 * 60_000)).toEqual(["gemini-3.5-flash-lite"]); // 10:50 still resting
    expect(coolingModels(Date.UTC(2026, 10, 6, 11, 0, 1))).toEqual([]); // 11:00 UTC: free again
  });

  it("reports cooldown without any call when every model is resting, and the last 429 when all just failed", async () => {
    const all429 = vi.fn(async () => apiError(429, "RESOURCE_EXHAUSTED", "Quota exceeded"));
    const first = await generateJson({ ...at(5_000_000), fetchImpl: all429 as never });
    expect(first).toMatchObject({ ok: false, reason: "rate_limited", status: 429 });
    expect(all429).toHaveBeenCalledTimes(4);
    const second = await generateJson({ ...at(5_010_000), fetchImpl: all429 as never });
    expect(second).toMatchObject({ ok: false, reason: "cooldown" });
    expect(all429).toHaveBeenCalledTimes(4);
  });

  it("does not fall through on a 400 (bad key or request), and logs the model and status", async () => {
    const f = vi.fn(async () => apiError(400, "INVALID_ARGUMENT", "API key not valid."));
    const r = await generateJson({ ...at(7_000_000), fetchImpl: f as never });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(f).toHaveBeenCalledTimes(1);
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatch(/Gemini 400.*\(model=gemini-3\.5-flash-lite\)/);
  });
});
