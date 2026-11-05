import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/studio/ai/route";
import { createStudioAdapter } from "@/components/studio/adapter";
import { resetLlmCooldown } from "@/lib/llm";
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
    const cookie = `ql_ws=ws_${"a".repeat(32)}`;
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await post(baseReq(), `10.0.0.${i}`, cookie)).status; // distinct IPs: the workspace limit bites
    expect(last).toBe(429);
    const limited = await post(baseReq(), "10.9.9.9", cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.text()).not.toContain(KEY);

    installTestDb(); // resets limits
    for (let i = 0; i < 60; i++) last = (await post(baseReq(), "8.8.8.8")).status; // no cookie: the IP limit bites
    expect(last).toBe(200);
    expect((await post(baseReq(), "8.8.8.8")).status).toBe(429);
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
    expect((await res.json()).error).toMatchObject({ code: "ai_off", message: expect.stringContaining("no Gemini API key") });
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
    const fetchImpl = vi.fn(async () => Response.json({ error: { code: "ai_off", message: "The AI assistant is off: this server has no Gemini API key." } }, { status: 503 })) as unknown as typeof fetch;
    const h = createStudioAdapter({ getApi: () => ({ getState: () => ({ pages: [], selectedPageId: "x" }), setState }) as never, fetchImpl }).executeTurn(request("make me a funnel"));
    const r = await h.complete;
    const text = JSON.stringify(r.output);
    expect(r.status).toBe("completed");
    expect(text).toContain("The AI assistant is off");
    expect(text).toContain("prompt starters still load prebuilt reports");
    expect(setState).not.toHaveBeenCalled();
  });

  it("loads the prebuilt report for a prompt starter when the model is down", async () => {
    const setState = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const starter = PROMPT_STARTERS[0];
    const api = { getState: () => ({ pages: [], selectedPageId: "old", panels: { filters: { collapsed: true } } }), setState };
    const r = await createStudioAdapter({ getApi: () => api as never, fetchImpl }).executeTurn(request(starter.prompt)).complete;
    expect(setState).toHaveBeenCalledTimes(1);
    const next = setState.mock.calls[0][0];
    expect(next.selectedPageId).toBe(starter.state.selectedPageId);
    expect(next.panels).toEqual({ filters: { collapsed: true } }); // the rest of the state is kept
    expect(JSON.stringify(r.output)).toContain("Showing a prebuilt report instead");
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
