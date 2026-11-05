// Browser side of the AG Studio agent framework: an AgLlmAdapter that talks to our own /api/studio/ai route (the Gemini key stays on the server).
// If the model is unavailable, a turn is answered with a plain assistant message saying so; and when the user's message is exactly one of the
// prompt starters, the matching prebuilt report is applied instead, so the demo still works without a model.
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

  /** Never rejects: every failure becomes a completed assistant message that says what happened. */
  async function run(request: AgLlmRequest, signal?: AbortSignal): Promise<AgLlmResponse> {
    let message = "The AI assistant is unavailable right now.";
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        signal,
        body: JSON.stringify({ input: request.input, instructions: request.instructions, tools: request.tools, toolChoice: request.toolChoice, responseFormat: request.responseFormat }),
      });
      const body = (await res.json().catch(() => null)) as (Partial<AgLlmResponse> & { error?: { message?: string } | string; message?: string }) | null;
      if (res.ok && body && Array.isArray(body.output)) return body as AgLlmResponse;
      const m = typeof body?.error === "object" ? body.error?.message : body?.message;
      if (m) message = m;
    } catch (e) {
      if (signal?.aborted) return { id: "aborted", createdAt: Date.now(), status: "cancelled", output: [] };
      message = "Could not reach the AI assistant. Check your connection.";
      void e;
    }
    return unavailable(request, message);
  }

  function unavailable(request: AgLlmRequest, message: string): AgLlmResponse {
    const starter = starterFor(lastUserText(request));
    const api = opts.getApi();
    if (starter && api) {
      try {
        api.setState({ ...(api.getState() as AgReportState), pages: starter.state.pages, selectedPageId: starter.state.selectedPageId } as AgReportState);
        return reply(`${message} ${starter.reply}`);
      } catch {
        /* fall through to the plain message */
      }
    }
    return reply(`${message} The prompt starters still load prebuilt reports.`);
  }

  return {
    executeTurn(request, options) {
      const complete = run(request, options?.signal);
      return { stream: events(complete), complete };
    },
  };
}
