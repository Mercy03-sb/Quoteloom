// Browser side of the AG Studio agent framework: an AgLlmAdapter that talks to our own /api/studio/ai route (the Gemini key stays on the server).
// - A prompt starter (the user's message is exactly a starter's prompt) never reaches the network: the prebuilt report is applied locally.
// - A free-text prompt goes to the route. Its whole answer (every turn) is cached by prompt + dashboard state, so repeating it costs nothing.
// - If the model is unavailable, the turn is answered with a plain assistant message (the server words it; raw errors are never shown).
import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgReportState, AgStudioApi } from "ag-studio";
import { starterFor } from "@/lib/studio-report";

type Fetch = typeof fetch;
export type AdapterOptions = { getApi: () => Pick<AgStudioApi, "getState" | "setState"> | undefined; endpoint?: string; fetchImpl?: Fetch };

const msgItem = (id: string, text: string) =>
  ({ id, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text, annotations: [] }] }) as AgLlmResponse["output"][number];

const reply = (text: string, extra: Partial<AgLlmResponse> = {}): AgLlmResponse => ({
  id: `local_${Date.now().toString(36)}`,
  createdAt: Date.now(),
  status: "completed",
  output: [msgItem(`local_msg_${Date.now().toString(36)}`, text)],
  ...extra,
});

function lastUserText(request: AgLlmRequest): string {
  for (let i = request.input.length - 1; i >= 0; i--) {
    const it = request.input[i];
    if (it.type === "message" && it.role === "user") return it.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  return "";
}

/** A request starts a new prompt when its last item is the user's message (otherwise it is a tool result going back to the model). */
function startsPrompt(request: AgLlmRequest): boolean {
  const last = request.input[request.input.length - 1];
  return Boolean(last && last.type === "message" && last.role === "user");
}

const CACHE_MAX = 30;
/** prompt + dashboard state -> the model's answers for each turn of that prompt (tool calls, then the final text). Memory only. */
const answers = new Map<string, AgLlmResponse[]>();
export function clearStudioCache(): void {
  answers.clear();
}

/** The dashboard as the model sees it, minus panel layout (opening a panel does not change what a prompt means). */
function stateKey(api: Pick<AgStudioApi, "getState"> | undefined): string {
  try {
    const state = { ...((api?.getState() ?? {}) as Record<string, unknown>) };
    delete state.panels;
    return JSON.stringify(state);
  } catch {
    return "";
  }
}

/** The final text answer, labelled "(cached)" so the reader knows no model call was made. */
function labelCached(r: AgLlmResponse): AgLlmResponse {
  if (r.output.some((o) => o.type === "function_call")) return r;
  const out = [...r.output];
  for (let i = out.length - 1; i >= 0; i--) {
    const o = out[i];
    if (o.type === "message") {
      const last = o.content.length - 1;
      out[i] = { ...o, content: o.content.map((c, j) => (j === last && c.type === "text" ? { ...c, text: `${c.text} (cached)` } : c)) } as typeof o;
      return { ...r, output: out };
    }
  }
  return { ...r, output: [...out, msgItem(`cached_msg_${Date.now().toString(36)}`, "(cached)")] };
}

/** Replays a finished response as the stream events Studio reads (the route answers in one piece, not as SSE). */
async function* events(done: Promise<AgLlmResponse>): AsyncGenerator<AgAiEvent> {
  const r = await done;
  for (const o of r.output) {
    if (o.type === "message") {
      const text = o.content.map((c) => (c.type === "text" ? c.text : c.refusal)).join("");
      yield { type: "TEXT_MESSAGE_START", messageId: o.id, role: "assistant" };
      yield { type: "TEXT_MESSAGE_CONTENT", messageId: o.id, delta: text };
      yield { type: "TEXT_MESSAGE_END", messageId: o.id };
    } else if (o.type === "function_call") {
      yield { type: "TOOL_CALL_START", toolCallId: o.callId, toolCallName: o.name };
      yield { type: "TOOL_CALL_ARGS", toolCallId: o.callId, delta: o.arguments };
      yield { type: "TOOL_CALL_END", toolCallId: o.callId };
    }
  }
}

export function createStudioAdapter(opts: AdapterOptions): AgLlmAdapter {
  const doFetch: Fetch = opts.fetchImpl ?? ((...a) => fetch(...a));
  const endpoint = opts.endpoint ?? "/api/studio/ai";
  /** The free-text prompt being answered: its cache key, the answers recorded so far, and the cached answers being replayed (if any). */
  let current: { key: string; recorded: AgLlmResponse[]; replay?: AgLlmResponse[]; turn: number } | undefined;

  /** Never rejects. Returns the route's answer, or a local assistant message (ok: false) that says what happened. */
  async function run(request: AgLlmRequest, signal?: AbortSignal): Promise<{ ok: boolean; response: AgLlmResponse }> {
    let message = "The AI assistant is unavailable right now. Use the prompt starters.";
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        signal,
        body: JSON.stringify({ input: request.input, instructions: request.instructions, tools: request.tools, toolChoice: request.toolChoice, responseFormat: request.responseFormat }),
      });
      const body = (await res.json().catch(() => null)) as (Partial<AgLlmResponse> & { error?: { message?: string } | string }) | null;
      if (res.ok && body && Array.isArray(body.output)) return { ok: true, response: body as AgLlmResponse };
      if (res.status === 429 && body?.error === "rate_limited") message = "The AI assistant is resting. Use the prompt starters.";
      else if (typeof body?.error === "object" && body.error?.message) message = body.error.message; // the route words these itself; raw bodies are never shown
    } catch {
      if (signal?.aborted) return { ok: false, response: { id: "aborted", createdAt: Date.now(), status: "cancelled", output: [] } };
      message = "Could not reach the AI assistant. Check your connection, or use the prompt starters.";
    }
    return { ok: false, response: reply(message) };
  }

  /** Apply a starter's prebuilt report locally. Undefined when this is not a starter (or Studio's API is not ready). */
  function starter(request: AgLlmRequest): AgLlmResponse | undefined {
    const s = starterFor(lastUserText(request));
    const api = opts.getApi();
    if (!s || !api) return undefined;
    try {
      api.setState({ ...(api.getState() as AgReportState), pages: s.state.pages, selectedPageId: s.state.selectedPageId } as AgReportState);
      return reply(s.reply);
    } catch {
      return undefined;
    }
  }

  async function turn(request: AgLlmRequest, signal?: AbortSignal): Promise<AgLlmResponse> {
    if (startsPrompt(request)) {
      const local = starter(request);
      if (local) {
        current = undefined;
        return local; // no network, no model call
      }
      const key = `${lastUserText(request).trim()}\u0000${stateKey(opts.getApi())}`;
      current = { key, recorded: [], replay: answers.get(key), turn: 0 };
    }
    const cur = current;
    const cached = cur?.replay?.[cur.turn];
    if (cur && cached) {
      cur.turn += 1;
      return labelCached(cached);
    }
    if (cur) cur.replay = undefined; // the conversation no longer matches the recording
    const { ok, response } = await run(request, signal);
    if (cur && current === cur) {
      if (!ok) {
        current = undefined; // a failed answer is never cached
      } else {
        cur.recorded.push(response);
        if (!response.output.some((o) => o.type === "function_call") && response.status === "completed") {
          if (answers.size >= CACHE_MAX) answers.delete(answers.keys().next().value as string);
          answers.set(cur.key, cur.recorded);
          current = undefined;
        }
      }
    }
    return response;
  }

  return {
    executeTurn(request, options) {
      const complete = turn(request, options?.signal);
      return { stream: events(complete), complete };
    },
  };
}
