import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "@/lib/db";
import { describeFailure, generateJson, redact, resetLlmCooldown } from "@/lib/llm";
import { ingestUrl, type PageFetcher } from "@/lib/ingest/pipeline";

const KEY = "AIzaSyFAKEKEY0123456789abcdefghijklmnop";
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
    expect(redact(`oops AIza${"x".repeat(35)} oops`, undefined)).toBe("oops [redacted] oops");
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
