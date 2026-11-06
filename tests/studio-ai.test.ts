import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/studio/ai/route";
import { clearStudioCache, createStudioAdapter } from "@/components/studio/adapter";
import { resetBudget } from "@/lib/budget";
import { resetLlmCooldown } from "@/lib/llm";
import { resetPrompts } from "@/lib/studio-prompts";
import { MAX_BODY_BYTES, StudioAiRequest, toGeminiBody, toStudioResponse } from "@/lib/studio-ai";
import { PROMPT_STARTERS } from "@/lib/studio-report";
import { installTestDb } from "./helpers";

// Built at runtime so no key-shaped literal appears in source (GitHub secret scanning).
const KEY = ["AI", "za"].join("") + ["SyFAKEKEY", "0123456789", "abcdefghijklmnop"].join("");

const userMsg = (text: string) => ({ id: "m1", kind: "input", type: "message", role: "user", content: [{ type: "text", text }], status: "completed" });
const baseReq = (over: Record<string, unknown> = {}) => ({
  input: [userMsg("Chart sales per day")],
  instructions: "You build dashboards.",
  tools: [{ name: "add_widget", description: "Add a widget", parameters: { type: "object", properties: { type: { type: "string" } } } }],
  toolChoice: "auto",
  responseFormat: { type: "text" },
  ...over,
});
const post = (body: unknown, ip = "5.5.5.5", cookie?: string) =>
  POST(new Request("http://localhost:3000/api/studio/ai", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }));

const geminiOk = (parts: unknown[], finishReason = "STOP") => new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason }] }), { status: 200 });
const geminiErr = (status: number, s: string, message: string) => new Response(JSON.stringify({ error: { code: status, message, status: s } }), { status });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  installTestDb();
  resetLlmCooldown();
  resetBudget();
  resetPrompts();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("GEMINI_API_KEY", KEY);
  vi.stubEnv("GEMINI_MODEL", "");
  fetchMock = vi.fn(async () => geminiOk([{ text: "Done." }]));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/studio/ai", () => {
  it("answers in the AgLlmResponse shape and never returns or forwards the key in the body", async () => {
    fetchMock.mockResolvedValueOnce(geminiOk([{ text: "Adding a chart." }, { functionCall: { name: "add_widget", args: { type: "line-chart" } }, thoughtSignature: "sig1" }]));
    const res = await post(baseReq());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(body.status).toBe("completed");
    expect(body.output[0]).toMatchObject({ type: "message", role: "assistant", kind: "output" });
    expect(body.output[1]).toMatchObject({ type: "function_call", name: "add_widget", arguments: JSON.stringify({ type: "line-chart" }) });
    // the key goes to Google in a header only, never in the URL or body
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });

  it("GET reports availability as a boolean and never the key", async () => {
    const on = await (await GET()).text();
    expect(JSON.parse(on)).toEqual({ available: true });
    expect(on).not.toContain(KEY);
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await (await GET()).json()).toEqual({ available: false });
  });

  it("rate limits per workspace and per IP", async () => {
    // Continuation turns (a tool result going back) never start a prompt, so only the general per-minute limiter counts them.
    const cont = () => baseReq({ input: [userMsg("x"), { type: "function_call_output", callId: "c1", output: "{}", status: "completed" }] });
    const isLimited = async (r: Response) => (await r.json()).error === "rate_limited";
    const cookie = `ql_ws=ws_${"a".repeat(32)}`;
    for (let i = 0; i < 30; i++) expect(await isLimited(await post(cont(), `10.0.0.${i}`, cookie))).toBe(false); // distinct IPs: the workspace limit bites
    const limited = await post(cont(), "10.9.9.9", cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.text()).not.toContain(KEY);

    installTestDb(); // resets limits
    for (let i = 0; i < 60; i++) expect(await isLimited(await post(cont(), "8.8.8.8"))).toBe(false); // no cookie: the IP limit bites
    expect(await isLimited(await post(cont(), "8.8.8.8"))).toBe(true);
  });

  it("handles Gemini overload (503), with a clear message and no key", async () => {
    fetchMock.mockResolvedValue(geminiErr(503, "UNAVAILABLE", `This model is overloaded (key ${KEY})`));
    const res = await post(baseReq());
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text).error).toMatchObject({ code: "ai_overloaded", message: expect.stringMatching(/overloaded/i) });
    expect(text).not.toContain(KEY);
  });

  it("handles a Gemini rate limit, a timeout, a network failure and an empty answer", async () => {
    for (let i = 0; i < 4; i++) fetchMock.mockResolvedValueOnce(geminiErr(429, "RESOURCE_EXHAUSTED", "Quota exceeded")); // every fallback model is limited
    expect((await (await post(baseReq())).json()).error.code).toBe("ai_busy");
    resetLlmCooldown();
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    const t = await post(baseReq());
    expect(t.status).toBe(504);
    expect((await t.json()).error.code).toBe("ai_timeout");
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: `lookup failed for ${KEY}` } }));
    const n = await post(baseReq());
    expect(n.status).toBe(502);
    expect(await n.text()).not.toContain(KEY);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    expect((await (await post(baseReq())).json()).error.code).toBe("ai_empty");
  });

  it("reports a missing key plainly, without calling Gemini", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const res = await post(baseReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ code: "ai_off", message: expect.stringContaining("no Gemini key") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries once with the default model when GEMINI_MODEL is missing, but not on a 400", async () => {
    vi.stubEnv("GEMINI_MODEL", "gemini-nonexistent");
    fetchMock.mockResolvedValueOnce(geminiErr(404, "NOT_FOUND", "model not found")).mockResolvedValueOnce(geminiOk([{ text: "ok" }]));
    expect((await post(baseReq())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("gemini-nonexistent");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("gemini-nonexistent");
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(geminiErr(400, "INVALID_ARGUMENT", "bad"));
    expect((await post(baseReq())).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps request size and rejects malformed requests without calling Gemini", async () => {
    const big = await post(baseReq({ instructions: "x".repeat(MAX_BODY_BYTES + 10) }));
    expect(big.status).toBe(413);
    expect((await post("not json")).status).toBe(400);
    expect((await post({ input: "nope" })).status).toBe(400);
    expect((await post(baseReq({ tools: [{ name: "bad name!", description: "", parameters: {} }] }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("request and response translation", () => {
  const parse = (o: Record<string, unknown>) => StudioAiRequest.parse(baseReq(o));

  it("forwards only client function tools, caps output tokens and adds the guard rules", () => {
    const body = toGeminiBody(
      parse({
        tools: [
          { name: "view_schema", description: "d", parameters: { type: "object" } },
          { name: "web_search", description: "d", parameters: {}, kind: "provided" },
          { name: "server_tool", description: "d", parameters: {}, kind: "server" },
        ],
        toolChoice: { name: "view_schema" },
      }),
    ) as { tools: { functionDeclarations: { name: string }[] }[]; toolConfig: unknown; generationConfig: { maxOutputTokens: number }; systemInstruction: { parts: { text: string }[] } };
    expect(body.tools[0].functionDeclarations.map((f) => f.name)).toEqual(["view_schema"]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["view_schema"] } });
    expect(body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(4096);
    expect(body.systemInstruction.parts[0].text).toContain("only by calling the provided tools");
    expect(body.systemInstruction.parts[0].text).toContain("no access to costs, floor prices");
  });

  it("replays tool calls and results, merging parallel results into one turn", () => {
    const call = (callId: string, name: string) => ({ id: `i_${callId}`, kind: "output", type: "function_call", callId, name, arguments: '{"a":1}', status: "completed" });
    const out = (callId: string, output: string) => ({ type: "function_call_output", callId, output, status: "completed" });
    const body = toGeminiBody(parse({ input: [userMsg("go"), call("c1", "view_schema"), call("c2", "execute_query"), out("c1", '{"tables":[]}'), out("c2", "plain text")] })) as {
      contents: { role: string; parts: Record<string, any>[] }[];
    };
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[1].parts).toHaveLength(2);
    expect(body.contents[2].parts[0].functionResponse).toEqual({ name: "view_schema", response: { tables: [] } });
    expect(body.contents[2].parts[1].functionResponse).toEqual({ name: "execute_query", response: { output: "plain text" } });
  });

  it("marks a cut-off answer incomplete", () => {
    const r = toStudioResponse({ ok: true, model: "m", parts: [{ text: "partial" }], finishReason: "MAX_TOKENS", usage: { inputTokens: 0, outputTokens: 0 }, attempts: 1 });
    expect(r).toMatchObject({ status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } });
  });
});

describe("browser adapter", () => {
  const request = (text: string) => ({ input: [userMsg(text)], responseFormat: { type: "text" } }) as never;
  const drain = async (stream: AsyncIterable<{ type: string }>) => {
    const types: string[] = [];
    for await (const e of stream) types.push(e.type);
    return types;
  };

  it("replays a model answer as stream events and resolves complete", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        id: "r1",
        createdAt: 1,
        status: "completed",
        output: [
          { id: "m", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "hi", annotations: [] }] },
          { id: "f", kind: "output", type: "function_call", callId: "c1", name: "add_widget", arguments: "{}", status: "completed" },
        ],
      }),
    ) as unknown as typeof fetch;
    const h = createStudioAdapter({ getApi: () => undefined, fetchImpl }).executeTurn(request("hello"));
    expect(await drain(h.stream)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect((await h.complete).status).toBe("completed");
  });

  it("says plainly that the model is unavailable, and does not touch the report for a free-text prompt", async () => {
    const setState = vi.fn();
    const fetchImpl = vi.fn(async () => Response.json({ error: { code: "ai_off", message: "The AI assistant is off here (no Gemini key is set up). Use the prompt starters." } }, { status: 503 })) as unknown as typeof fetch;
    const h = createStudioAdapter({ getApi: () => ({ getState: () => ({ pages: [], selectedPageId: "x" }), setState }) as never, fetchImpl }).executeTurn(request("make me a funnel"));
    const r = await h.complete;
    const text = JSON.stringify(r.output);
    expect(r.status).toBe("completed");
    expect(text).toContain("The AI assistant is off");
    expect(text).toContain("Use the prompt starters");
    expect(setState).not.toHaveBeenCalled();
  });

  it("loads every prompt starter's prebuilt report locally: no network call at all, even with the model up", async () => {
    for (const starter of PROMPT_STARTERS) {
      const setState = vi.fn();
      const fetchImpl = vi.fn();
      const api = { getState: () => ({ pages: [], selectedPageId: "old", panels: { filters: { collapsed: true } } }), setState };
      const r = await createStudioAdapter({ getApi: () => api as never, fetchImpl: fetchImpl as never }).executeTurn(request(starter.prompt)).complete;
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(setState).toHaveBeenCalledTimes(1);
      const next = setState.mock.calls[0][0];
      expect(next.selectedPageId).toBe(starter.state.selectedPageId);
      expect(next.panels).toEqual({ filters: { collapsed: true } }); // the rest of the state is kept
      expect(JSON.stringify(r.output)).toMatch(/Loaded the prebuilt .* \(no AI used\)/);
    }
  });

  it("matches a starter typed by hand (case, final period and label): still no network call", async () => {
    for (const text of ["Chart sales per day", "chart sales per day.", "Chart sales per day."]) {
      const fetchImpl = vi.fn();
      const api = { getState: () => ({ pages: [], selectedPageId: "old" }), setState: vi.fn() };
      await createStudioAdapter({ getApi: () => api as never, fetchImpl: fetchImpl as never }).executeTurn(request(text)).complete;
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(api.setState).toHaveBeenCalledTimes(1);
    }
  });

  it("caches a free-text answer by prompt and dashboard state, and labels the replay (cached)", async () => {
    clearStudioCache();
    let state: unknown = { pages: [{ id: "a" }], selectedPageId: "a", panels: { filters: { collapsed: true } } };
    const api = { getState: () => state, setState: vi.fn() };
    const answer = (text: string) => ({ id: "r", createdAt: 1, status: "completed", output: [{ id: "m", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }] });
    const fetchImpl = vi.fn(async () => Response.json(answer("Orders are mostly paid."))) as unknown as typeof fetch;
    const adapter = createStudioAdapter({ getApi: () => api as never, fetchImpl });
    const text = async (q: string) => JSON.stringify((await adapter.executeTurn(request(q)).complete).output);

    expect(await text("How are orders doing?")).not.toContain("(cached)");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await text("How are orders doing?")).toContain("Orders are mostly paid. (cached)");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second time: no call
    state = { pages: [{ id: "a" }], selectedPageId: "a", panels: { filters: { collapsed: false } } }; // panel layout is not part of the key
    expect(await text("How are orders doing?")).toContain("(cached)");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    state = { pages: [{ id: "b" }], selectedPageId: "b" }; // different dashboard: a fresh answer
    expect(await text("How are orders doing?")).not.toContain("(cached)");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await text("A different question")).not.toContain("(cached)");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("replays a multi-turn answer (tool calls, then text) from the cache and never caches a failure", async () => {
    clearStudioCache();
    const api = { getState: () => ({ pages: [], selectedPageId: "x" }), setState: vi.fn() };
    const msg = (text: string) => ({ id: "m", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] });
    const call = { id: "f", kind: "output", type: "function_call", callId: "c1", name: "add_widget", arguments: "{}", status: "completed" };
    const replies = [{ id: "r1", createdAt: 1, status: "completed", output: [call] }, { id: "r2", createdAt: 1, status: "completed", output: [msg("Added.")] }];
    const fetchImpl = vi.fn(async () => Response.json(replies.shift())) as unknown as typeof fetch;
    const adapter = createStudioAdapter({ getApi: () => api as never, fetchImpl });
    const followUp = { input: [userMsg("Add a chart"), call, { type: "function_call_output", callId: "c1", output: "{}", status: "completed" }] } as never;
    await adapter.executeTurn(request("Add a chart")).complete;
    await adapter.executeTurn(followUp).complete;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const again1 = await adapter.executeTurn(request("Add a chart")).complete;
    const again2 = await adapter.executeTurn(followUp).complete;
    expect(fetchImpl).toHaveBeenCalledTimes(2); // both turns replayed
    expect(JSON.stringify(again1.output)).toContain("add_widget");
    expect(JSON.stringify(again2.output)).toContain("Added. (cached)");

    clearStudioCache();
    const down = vi.fn(async () => Response.json({ error: { code: "ai_busy", message: "The AI model is busy." } }, { status: 503 })) as unknown as typeof fetch;
    const flaky = createStudioAdapter({ getApi: () => api as never, fetchImpl: down });
    await flaky.executeTurn(request("Hello there")).complete;
    await flaky.executeTurn(request("Hello there")).complete;
    expect(down).toHaveBeenCalledTimes(2); // an error answer is not cached
  });

  it("shows only our own wording to the reader: never a raw Google error, a stack trace or a key", async () => {
    clearStudioCache();
    const raw = `{"error":{"code":429,"message":"Quota exceeded for metric ... ${KEY}","status":"RESOURCE_EXHAUSTED"}} at Object.<anonymous> (stack.js:1:1)`;
    const fetchImpl = vi.fn(async () => new Response(raw, { status: 502 })) as unknown as typeof fetch;
    const r = await createStudioAdapter({ getApi: () => undefined, fetchImpl }).executeTurn(request("free text one")).complete;
    const text = JSON.stringify(r.output);
    expect(text).toContain("The AI assistant is unavailable right now. Use the prompt starters.");
    expect(text).not.toMatch(/RESOURCE_EXHAUSTED|Quota exceeded|stack\.js|Object\.<anonymous>/);
    expect(text).not.toContain(KEY);
  });

  it("reports an aborted turn as cancelled", async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn(async () => {
      ctl.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await createStudioAdapter({ getApi: () => undefined, fetchImpl }).executeTurn(request("x"), { signal: ctl.signal }).complete;
    expect(r.status).toBe("cancelled");
  });
});

describe("one prompt takes at most 4 model turns", () => {
  const toolOut = (id: string) => ({ type: "function_call_output", callId: id, output: "{}", status: "completed" });
  const fc = (id: string) => ({ id, kind: "output", type: "function_call", callId: id, name: "add_widget", arguments: "{}", status: "completed" });
  const turn = (n: number) => baseReq({ input: [userMsg("Show orders by status"), ...Array.from({ length: n }, (_, i) => fc(`c${i}`)), ...(n ? [toolOut(`c${n - 1}`)] : [])] });
  const toolModes = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).toolConfig?.functionCallingConfig?.mode);

  it("forces a text answer on the fourth turn and refuses a fifth without calling Gemini", async () => {
    fetchMock.mockImplementation(async () => geminiOk([{ functionCall: { name: "add_widget", args: {} } }]));
    for (const n of [0, 1, 2]) expect((await post(turn(n))).status).toBe(200);
    fetchMock.mockImplementation(async () => geminiOk([{ text: "Done." }]));
    expect((await post(turn(3))).status).toBe(200);
    expect(toolModes()).toEqual(["AUTO", "AUTO", "AUTO", "NONE"]); // turn 4 may not call tools
    const fifth = await post(turn(4));
    expect(fifth.status).toBe(429);
    const err = (await fifth.json()).error;
    expect(err.code).toBe("ai_turn_cap");
    expect(err.message).toMatch(/I added 4 widgets, but didn't finish within 4 steps.*Ask me to continue/); // says what was done and what is left
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("the last turn tells the model to say what is done and what is left, and a tool call or empty answer there becomes the cap message", async () => {
    fetchMock.mockImplementation(async () => geminiOk([{ functionCall: { name: "add_widget", args: {} } }]));
    for (const n of [0, 1, 2]) await post(turn(n));
    const res = await post(turn(3));
    const sent = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    expect(sent.systemInstruction.parts[0].text).toContain("last step and you have no tools");
    const out = (await res.json()).output;
    expect(out.every((o: { type: string }) => o.type === "message")).toBe(true);
    expect(JSON.stringify(out)).toMatch(/I added 3 widgets, but didn't finish within 4 steps.*Ask me to continue/);
  });

  it("a free-text chart prompt with a fake model: one tool turn, one text turn = 2 model calls (http_calls)", async () => {
    const info = console.info as unknown as { mock: { calls: unknown[][] } };
    fetchMock.mockResolvedValueOnce(geminiOk([{ functionCall: { name: "add_widget", args: {} } }])).mockResolvedValueOnce(geminiOk([{ text: "Added a line chart." }]));
    await post(baseReq({ input: [userMsg("Chart revenue per week")] }));
    await post(baseReq({ input: [userMsg("Chart revenue per week"), fc("c0"), toolOut("c0")] }));
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.join(" ")).toMatch(/turn=1\/4 http_calls=1 /);
    expect(lines[1]).toMatch(/turn=2\/4 http_calls=1 .*prompt total: model_turns=2 http_calls=2 /);
  });

  it("logs counts per turn and per prompt, never the prompt, the answer or the key", async () => {
    const info = console.info as unknown as { mock: { calls: unknown[][] } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "add_widget", args: {} } }] } }], usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 20 } }), { status: 200 }));
    await post(turn(0));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "SECRET ANSWER TEXT" }] } }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 30 } }), { status: 200 }));
    await post(turn(1));
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toMatch(/^\[studio-ai\] prompt=[0-9a-f]{6} turn=1\/4 http_calls=1 input_tokens=1234 model=gemini-3\.5-flash-lite$/);
    expect(lines[1]).toMatch(/turn=2\/4 http_calls=1 input_tokens=1500 .*prompt total: model_turns=2 http_calls=2 input_tokens=2734 output_tokens=50$/);
    const all = lines.join("\n");
    expect(all).not.toMatch(/orders by status|SECRET ANSWER|add_widget/);
    expect(all).not.toContain(KEY);
  });

  it("counts fallback calls in http_calls but not as extra turns", async () => {
    fetchMock.mockResolvedValueOnce(geminiErr(429, "RESOURCE_EXHAUSTED", "RequestsPerMinute")).mockResolvedValueOnce(geminiOk([{ text: "Hi" }]));
    await post(turn(0));
    const line = String((console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(line).toMatch(/turn=1\/4 http_calls=2 /);
  });
});

describe("messages for the chat panel", () => {
  const send = async () => {
    const res = await post(baseReq());
    return { status: res.status, text: await res.text() };
  };
  const logs = () => (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n");

  it("busy: every model is rate limited per minute -> plain 'busy' message, real error only in the server log", async () => {
    fetchMock.mockImplementation(async () => geminiErr(429, "RESOURCE_EXHAUSTED", `Quota exceeded for metric RequestsPerMinute, key ${KEY}`));
    const { status, text } = await send();
    expect(status).toBe(503);
    expect(JSON.parse(text).error).toMatchObject({ code: "ai_busy", message: expect.stringMatching(/busy.*backup models.*minute/i) });
    expect(text).not.toMatch(/RESOURCE_EXHAUSTED|Quota exceeded|gemini-3/);
    expect(text).not.toContain(KEY);
    expect(logs()).toMatch(/Gemini 429.*RESOURCE_EXHAUSTED.*\(model=gemini-3\.5-flash-lite\)/); // model and status are logged...
    expect(logs()).not.toContain(KEY); // ...the key never is
  });

  it("daily budget used: a daily 429 on every model -> the resting message", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] } }), { status: 429 }));
    const { text } = await send();
    expect(JSON.parse(text).error).toMatchObject({ code: "ai_resting", message: "The AI assistant is resting. Use the prompt starters." });
    expect(fetchMock).toHaveBeenCalledTimes(4); // each model tried once, then they rest until the next UTC hour
    resetPrompts();
    fetchMock.mockClear();
    await send(); // next prompt: all four are resting, so Gemini is not called at all
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unavailable: an unexpected error -> generic message, no raw text, no model name", async () => {
    fetchMock.mockImplementation(async () => new Response("Traceback: boom at internal/server.js:12 " + KEY, { status: 418 }));
    const { status, text } = await send();
    expect(status).toBe(502);
    expect(JSON.parse(text).error).toMatchObject({ code: "ai_failed", message: "The AI assistant is unavailable right now. Use the prompt starters." });
    expect(text).not.toMatch(/Traceback|server\.js|gemini-/);
    expect(text).not.toContain(KEY);
    expect(logs()).toMatch(/Gemini 418/);
  });
});
