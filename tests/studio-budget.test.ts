import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/studio/ai/route";
import { budgetUsed, canCall, dailyBudget, recordCall, resetBudget, studioBudget } from "@/lib/budget";
import { generateJson, resetLlmCooldown } from "@/lib/llm";
import { RESTING_MESSAGE } from "@/lib/studio-ai";
import { resetPrompts } from "@/lib/studio-prompts";
import { installTestDb } from "./helpers";
import { openDb } from "@/lib/db";

const KEY = ["AI", "za"].join("") + ["SyFAKEKEY", "0123456789", "abcdefghijklmnop"].join("");
const userMsg = (text: string) => ({ id: "m1", kind: "input", type: "message", role: "user", content: [{ type: "text", text }], status: "completed" });
const req = (text = "Show orders by status") => ({ input: [userMsg(text)], instructions: "x", tools: [], responseFormat: { type: "text" } });
const post = (ip: string, cookie?: string) =>
  POST(new Request("http://localhost:3000/api/studio/ai", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(req()) }));
const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  installTestDb();
  resetLlmCooldown();
  resetBudget();
  resetPrompts();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("GEMINI_API_KEY", KEY);
  vi.stubEnv("GEMINI_MODEL", "");
  vi.stubEnv("GEMINI_DAILY_BUDGET", "");
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const expectResting = async (res: Response) => {
  const text = await res.text();
  expect(res.status).toBe(429);
  expect(JSON.parse(text).error).toMatchObject({ code: "ai_resting", message: RESTING_MESSAGE });
  expect(RESTING_MESSAGE).toBe("The AI assistant is resting. Use the prompt starters.");
  expect(text).not.toContain(KEY);
};

describe("Studio prompt limits", () => {
  it("allows 10 prompts a day per IP, then rests without calling Gemini", async () => {
    for (let i = 0; i < 10; i++) expect((await post("4.4.4.4", `ql_ws=ws_${String(i).padStart(32, "0")}`)).status).toBe(200); // new workspace each time
    expect(fetchMock).toHaveBeenCalledTimes(10);
    await expectResting(await post("4.4.4.4", `ql_ws=ws_${"9".repeat(32)}`));
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect((await post("4.4.4.5")).status).toBe(200); // another IP is unaffected
  });

  it("allows 10 prompts an hour per workspace, then rests without calling Gemini", async () => {
    const cookie = `ql_ws=ws_${"b".repeat(32)}`;
    for (let i = 0; i < 10; i++) expect((await post(`7.7.7.${i}`, cookie)).status).toBe(200); // a different IP each time
    await expectResting(await post("7.7.7.99", cookie));
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

describe("daily budget", () => {
  it("defaults to 400 calls, is set by GEMINI_DAILY_BUDGET, and keeps 40% for the playground and shop setup", () => {
    expect(dailyBudget({})).toBe(400);
    expect(studioBudget({})).toBe(240);
    expect(dailyBudget({ GEMINI_DAILY_BUDGET: "50" })).toBe(50);
    expect(studioBudget({ GEMINI_DAILY_BUDGET: "50" })).toBe(30);
    expect(dailyBudget({ GEMINI_DAILY_BUDGET: "nope" })).toBe(400);
  });

  it("stops Studio at its share while the rest of the app can still call, until the total is used", () => {
    const env = { GEMINI_DAILY_BUDGET: "10" };
    for (let i = 0; i < 6; i++) recordCall("studio");
    expect(canCall("studio", env)).toBe(false); // 60% of 10
    expect(canCall("app", env)).toBe(true); // reserve
    for (let i = 0; i < 4; i++) recordCall("app");
    expect(canCall("app", env)).toBe(false);
    expect(budgetUsed()).toEqual({ total: 10, studio: 6 });
  });

  it("starts again on a new UTC day", () => {
    const day1 = Date.UTC(2026, 10, 6, 12);
    for (let i = 0; i < 5; i++) recordCall("studio", day1);
    expect(budgetUsed(day1).total).toBe(5);
    expect(budgetUsed(day1 + 24 * 3600_000).total).toBe(0);
  });

  it("rests the Studio route once Studio's share is used, without calling Gemini", async () => {
    vi.stubEnv("GEMINI_DAILY_BUDGET", "10");
    for (let i = 0; i < 6; i++) recordCall("studio");
    await expectResting(await post("3.3.3.3"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts calls made by fallback models", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "RequestsPerMinute" } }), { status: 429 }))
      .mockResolvedValueOnce(ok());
    expect((await post("2.2.2.2")).status).toBe(200);
    expect(budgetUsed()).toEqual({ total: 2, studio: 2 });
  });

  it("makes the playground and shop setup fall back to rules once the whole budget is used, without calling Gemini", async () => {
    const env = { GEMINI_API_KEY: KEY, GEMINI_DAILY_BUDGET: "3" };
    for (let i = 0; i < 3; i++) recordCall("app");
    const r = await generateJson({ db: openDb(":memory:"), system: "s", input: "i", env, fetchImpl: fetchMock as never });
    expect(r).toMatchObject({ ok: false, reason: "budget" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
